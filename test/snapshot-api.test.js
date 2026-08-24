"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { runHostedServer } = require("../src/hosted-server");

const READ_TOKEN = "read-token-123";
const WRITE_TOKEN = "write-token-123";

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "okf-generation-")));
  fs.writeFileSync(path.join(root, "alpha.md"), "---\ntype: Spec\ntitle: Alpha\n---\n\n# Alpha\n", "utf8");
  return root;
}

function digest(files) {
  const manifest = files.map((file) => ({
    path: file.path,
    sha256: crypto.createHash("sha256").update(file.content).digest("hex"),
  })).sort((a, b) => a.path.localeCompare(b.path));
  return crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

async function start(t, options) {
  const root = fixture();
  const hosted = await runHostedServer(Object.assign({
    rootPath: root,
    port: 0,
    readToken: READ_TOKEN,
    writeToken: WRITE_TOKEN,
  }, options || {}));
  t.after(async () => {
    await hosted.handler.close();
    await new Promise((resolve) => hosted.server.close(resolve));
  });
  return { root, hosted };
}

async function request(hosted, pathname, options) {
  const config = options || {};
  const headers = { accept: "application/json" };
  if (config.token) headers.authorization = `Bearer ${config.token}`;
  if (config.key) headers["idempotency-key"] = config.key;
  if (config.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${hosted.url}${pathname}`, {
    method: config.method || "GET",
    headers,
    ...(config.body !== undefined ? { body: JSON.stringify(config.body) } : {}),
  });
  const text = await response.text();
  return { response, payload: text ? JSON.parse(text) : null };
}

test("hosted snapshots require auth and serve only the active immutable generation", async (t) => {
  const { root, hosted } = await start(t);
  assert.equal((await request(hosted, "/v1/rollout/status")).response.status, 401);
  assert.equal((await request(hosted, "/v1/rollout/status", { token: "wrong" })).response.status, 403);

  const original = await request(hosted, "/v1/rollout/snapshot", { token: READ_TOKEN });
  assert.equal(original.response.status, 200);
  assert.equal(original.payload.persistence.servingSource, "active-generation");

  // External mutation of the compatibility root is never exposed by reads.
  fs.writeFileSync(path.join(root, "alpha.md"), "externally mutated\n", "utf8");
  fs.writeFileSync(path.join(root, "leak.md"), "external partial data\n", "utf8");
  const isolated = await request(hosted, "/v1/rollout/snapshot", { token: READ_TOKEN });
  assert.equal(isolated.payload.revision, original.payload.revision);
  assert.equal(isolated.payload.files.length, 1);
  assert.match(isolated.payload.files[0].content, /title: Alpha/);
});

test("preview binding, confirmation, principal and idempotency are enforced", async (t) => {
  const { hosted } = await start(t);
  const snapshot = (await request(hosted, "/v1/rollout/snapshot", { token: WRITE_TOKEN })).payload;
  const files = snapshot.files.map(({ path: filePath, content }) => ({ path: filePath, content }));
  files.push({ path: "beta.md", content: "---\ntype: Spec\ntitle: Beta\n---\n\n# Beta\n" });
  const body = { bundle: snapshot.bundle, baseRevision: snapshot.revision, candidateDigest: digest(files), files };

  const noDryKey = await request(hosted, "/v1/rollout/dry-run", {
    method: "POST", token: WRITE_TOKEN, body,
  });
  assert.equal(noDryKey.response.status, 422);
  assert.equal(noDryKey.payload.details.code, "idempotency_key_required");

  const dry = await request(hosted, "/v1/rollout/dry-run", {
    method: "POST", token: WRITE_TOKEN, key: "dry-preview-0001", body,
  });
  assert.equal(dry.response.status, 200);
  assert.match(dry.payload.previewId, /^pv_/);
  assert.match(dry.payload.canonicalRequestDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(dry.payload.changes.added, ["beta.md"]);

  const sameDry = await request(hosted, "/v1/rollout/dry-run", {
    method: "POST", token: WRITE_TOKEN, key: "dry-preview-0001", body,
  });
  assert.equal(sameDry.payload.previewId, dry.payload.previewId);
  assert.equal(sameDry.payload.replayed, true);

  const noConfirm = await request(hosted, "/v1/rollout/submit", {
    method: "POST", token: WRITE_TOKEN, key: "submit-preview-01",
    body: Object.assign({}, body, { previewId: dry.payload.previewId }),
  });
  assert.equal(noConfirm.response.status, 422);

  const changedFiles = files.map((file) => ({ ...file }));
  changedFiles[0].content += "tampered after preview\n";
  const bindingMismatch = await request(hosted, "/v1/rollout/submit", {
    method: "POST", token: WRITE_TOKEN, key: "submit-binding-01",
    body: Object.assign({}, body, {
      previewId: dry.payload.previewId,
      confirmed: true,
      files: changedFiles,
      candidateDigest: digest(changedFiles),
    }),
  });
  assert.equal(bindingMismatch.response.status, 422);

  // A different authenticated principal cannot submit the preview.
  const second = await runHostedServer({
    store: hosted.rollout.store,
    port: 0,
    readToken: "other-read-token",
    writeToken: "other-write-token",
    generationsRoot: hosted.manager.generationsRoot,
  });
  t.after(async () => {
    await second.handler.close();
    await new Promise((resolve) => second.server.close(resolve));
  });
  const wrongPrincipal = await request(second, "/v1/rollout/submit", {
    method: "POST", token: "other-write-token", key: "submit-other-001",
    body: Object.assign({}, body, { previewId: dry.payload.previewId, confirmed: true }),
  });
  assert.equal(wrongPrincipal.response.status, 403);

  const submitBody = Object.assign({}, body, { previewId: dry.payload.previewId, confirmed: true, message: "publish beta" });
  const submitted = await request(hosted, "/v1/rollout/submit", {
    method: "POST", token: WRITE_TOKEN, key: "submit-preview-01", body: submitBody,
  });
  assert.equal(submitted.response.status, 200);
  assert.equal(submitted.payload.published, true);

  const replay = await request(hosted, "/v1/rollout/submit", {
    method: "POST", token: WRITE_TOKEN, key: "submit-preview-01", body: submitBody,
  });
  assert.equal(replay.response.status, 200);
  assert.equal(replay.payload.generationId, submitted.payload.generationId);
  assert.equal(replay.payload.replayed, true);

  const different = Object.assign({}, submitBody, { message: "different request" });
  different.files = different.files.concat({ path: "gamma.md", content: "---\ntype: Spec\ntitle: Gamma\n---\n\n# Gamma\n" });
  different.candidateDigest = digest(different.files);
  const keyConflict = await request(hosted, "/v1/rollout/submit", {
    method: "POST", token: WRITE_TOKEN, key: "submit-preview-01", body: different,
  });
  assert.equal(keyConflict.response.status, 409);
});

test("hidden paths are rejected and active generations recover after restart", async (t) => {
  const { root, hosted } = await start(t);
  const snapshot = (await request(hosted, "/v1/rollout/snapshot", { token: WRITE_TOKEN })).payload;
  const unsafe = [{ path: ".git/control.md", content: "# no\n" }];
  const rejected = await request(hosted, "/v1/rollout/dry-run", {
    method: "POST", token: WRITE_TOKEN, key: "dry-hidden-0001",
    body: { bundle: snapshot.bundle, baseRevision: snapshot.revision, candidateDigest: digest(unsafe), files: unsafe },
  });
  assert.equal(rejected.response.status, 422);

  const files = snapshot.files.map(({ path: filePath, content }) => ({ path: filePath, content }));
  files.push({ path: "beta.md", content: "---\ntype: Spec\ntitle: Beta\n---\n\n# Beta\n" });
  const body = { bundle: snapshot.bundle, baseRevision: snapshot.revision, candidateDigest: digest(files), files };
  const dry = (await request(hosted, "/v1/rollout/dry-run", {
    method: "POST", token: WRITE_TOKEN, key: "dry-recovery-001", body,
  })).payload;
  const published = (await request(hosted, "/v1/rollout/submit", {
    method: "POST", token: WRITE_TOKEN, key: "sub-recovery-001",
    body: Object.assign({}, body, { previewId: dry.previewId, confirmed: true }),
  })).payload;

  const pointer = hosted.manager.activePointerPath(snapshot.bundle);
  fs.unlinkSync(pointer);
  fs.writeFileSync(path.join(root, "beta.md"), "corrupt external root\n", "utf8");
  const recovered = await runHostedServer({
    rootPath: root,
    port: 0,
    readToken: READ_TOKEN,
    writeToken: WRITE_TOKEN,
  });
  t.after(async () => {
    await recovered.handler.close();
    await new Promise((resolve) => recovered.server.close(resolve));
  });
  const afterRestart = await request(recovered, "/v1/rollout/snapshot", { token: READ_TOKEN });
  assert.equal(afterRestart.payload.revision, published.revision);
  assert.match(afterRestart.payload.files.find((file) => file.path === "beta.md").content, /title: Beta/);
});

test("one writer coordinator serializes competing hosted submissions", async (t) => {
  const { hosted } = await start(t);
  const snapshot = (await request(hosted, "/v1/rollout/snapshot", { token: WRITE_TOKEN })).payload;
  async function preview(name, key) {
    const files = [{ path: "alpha.md", content: `---\ntype: Spec\ntitle: ${name}\n---\n\n# ${name}\n` }];
    const body = { bundle: snapshot.bundle, baseRevision: snapshot.revision, candidateDigest: digest(files), files };
    const dry = (await request(hosted, "/v1/rollout/dry-run", { method: "POST", token: WRITE_TOKEN, key: `dry-${key}`, body })).payload;
    return { body: Object.assign({}, body, { previewId: dry.previewId, confirmed: true }), key: `sub-${key}` };
  }
  const first = await preview("First", "race-0001");
  const second = await preview("Second", "race-0002");
  const results = await Promise.all([
    request(hosted, "/v1/rollout/submit", { method: "POST", token: WRITE_TOKEN, key: first.key, body: first.body }),
    request(hosted, "/v1/rollout/submit", { method: "POST", token: WRITE_TOKEN, key: second.key, body: second.body }),
  ]);
  assert.deepEqual(results.map((entry) => entry.response.status).sort(), [200, 409]);
});

test("previews expire and hosted mode does not expose legacy proposal mutations", async (t) => {
  const { hosted } = await start(t, { previewTtlMs: 1 });
  const snapshot = (await request(hosted, "/v1/rollout/snapshot", { token: WRITE_TOKEN })).payload;
  const files = snapshot.files.map(({ path: filePath, content }) => ({ path: filePath, content }));
  files.push({ path: "beta.md", content: "---\ntype: Spec\ntitle: Beta\n---\n\n# Beta\n" });
  const body = { bundle: snapshot.bundle, baseRevision: snapshot.revision, candidateDigest: digest(files), files };
  const dry = (await request(hosted, "/v1/rollout/dry-run", {
    method: "POST", token: WRITE_TOKEN, key: "dry-expiry-0001", body,
  })).payload;
  await new Promise((resolve) => setTimeout(resolve, 5));
  const expired = await request(hosted, "/v1/rollout/submit", {
    method: "POST", token: WRITE_TOKEN, key: "sub-expiry-0001",
    body: Object.assign({}, body, { previewId: dry.previewId, confirmed: true }),
  });
  assert.equal(expired.response.status, 422);
  assert.equal(expired.payload.details.code, "preview_expired");

  const proposals = await request(hosted, "/v1/proposals", { token: WRITE_TOKEN });
  assert.equal(proposals.response.status, 404);
});

test("active generation bytes are digest-verified before serving", async (t) => {
  const { hosted } = await start(t);
  const snapshot = (await request(hosted, "/v1/rollout/snapshot", { token: READ_TOKEN })).payload;
  const filesDir = hosted.manager.filesDir(snapshot.bundle, snapshot.generationId);
  fs.appendFileSync(path.join(filesDir, "alpha.md"), "tampered\n", "utf8");
  const response = await request(hosted, "/v1/rollout/snapshot", { token: READ_TOKEN });
  assert.equal(response.response.status, 422);
  assert.match(response.payload.error, /digest verification/);
});

test("candidate validation builds the complete multi-bundle active project", async (t) => {
  const projectRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "okf-generation-project-")));
  const app = path.join(projectRoot, "app");
  const tables = path.join(projectRoot, "tables");
  fs.mkdirSync(app);
  fs.mkdirSync(tables);
  fs.writeFileSync(path.join(projectRoot, "okf.project.yaml"), [
    "project: HostedProject",
    "bundles:",
    "  - id: app",
    "    root: app",
    "  - id: tables",
    "    root: tables",
    "relationTypes:",
    "  - persists_to",
    "",
  ].join("\n"));
  const alpha = "---\nid: okf://app/alpha\ntype: Service\ntitle: Alpha\nrelations:\n  - type: persists_to\n    target: okf://tables/raw\n---\n\n# Alpha\n";
  fs.writeFileSync(path.join(app, "alpha.md"), alpha);
  fs.writeFileSync(path.join(tables, "raw.md"), "---\nid: okf://tables/raw\ntype: Table\ntitle: Raw\n---\n\n# Raw\n");
  const hosted = await runHostedServer({
    projectPath: path.join(projectRoot, "okf.project.yaml"),
    port: 0,
    readToken: READ_TOKEN,
    writeToken: WRITE_TOKEN,
  });
  t.after(async () => {
    await hosted.handler.close();
    await new Promise((resolve) => hosted.server.close(resolve));
  });
  const snapshot = (await request(hosted, "/v1/rollout/snapshot?bundle=app", { token: WRITE_TOKEN })).payload;
  const files = [{ path: "alpha.md", content: alpha.replace("# Alpha", "# Alpha updated") }];
  const dry = await request(hosted, "/v1/rollout/dry-run", {
    method: "POST",
    token: WRITE_TOKEN,
    key: "dry-multibundle-01",
    body: { bundle: "app", baseRevision: snapshot.revision, candidateDigest: digest(files), files },
  });
  assert.equal(dry.response.status, 200);
  assert.equal(dry.payload.valid, true);
});

test("concurrent same-key dry-runs and submits replay one identical result", async (t) => {
  const { hosted } = await start(t);
  const snapshot = (await request(hosted, "/v1/rollout/snapshot", { token: WRITE_TOKEN })).payload;
  const files = snapshot.files.map(({ path: filePath, content }) => ({ path: filePath, content }));
  files.push({ path: "beta.md", content: "---\ntype: Spec\ntitle: Beta\n---\n\n# Beta\n" });
  const body = { bundle: snapshot.bundle, baseRevision: snapshot.revision, candidateDigest: digest(files), files };

  const dryRuns = await Promise.all([
    request(hosted, "/v1/rollout/dry-run", { method: "POST", token: WRITE_TOKEN, key: "dry-concurrent-01", body }),
    request(hosted, "/v1/rollout/dry-run", { method: "POST", token: WRITE_TOKEN, key: "dry-concurrent-01", body }),
  ]);
  assert.deepEqual(dryRuns.map((entry) => entry.response.status), [200, 200]);
  assert.equal(dryRuns[0].payload.previewId, dryRuns[1].payload.previewId);

  const submitBody = Object.assign({}, body, { previewId: dryRuns[0].payload.previewId, confirmed: true });
  const submits = await Promise.all([
    request(hosted, "/v1/rollout/submit", { method: "POST", token: WRITE_TOKEN, key: "sub-concurrent-01", body: submitBody }),
    request(hosted, "/v1/rollout/submit", { method: "POST", token: WRITE_TOKEN, key: "sub-concurrent-01", body: submitBody }),
  ]);
  assert.deepEqual(submits.map((entry) => entry.response.status).sort(), [200, 200]);
  assert.equal(submits[0].payload.generationId, submits[1].payload.generationId);
  assert.equal(submits[0].payload.revision, submits[1].payload.revision);
  assert.equal(submits.filter((entry) => entry.payload.replayed === true).length, 1);
});

test("fault injection at the pointer boundary keeps retry semantics deterministic", async (t) => {
  const { root, hosted } = await start(t);
  const snapshot = (await request(hosted, "/v1/rollout/snapshot", { token: WRITE_TOKEN })).payload;
  const files = snapshot.files.map(({ path: filePath, content }) => ({ path: filePath, content }));
  files.push({ path: "beta.md", content: "---\ntype: Spec\ntitle: Beta\n---\n\n# Beta\n" });
  const body = { bundle: snapshot.bundle, baseRevision: snapshot.revision, candidateDigest: digest(files), files };
  const dry = (await request(hosted, "/v1/rollout/dry-run", {
    method: "POST", token: WRITE_TOKEN, key: "dry-fault-0001", body,
  })).payload;
  const submitBody = Object.assign({}, body, { previewId: dry.previewId, confirmed: true });

  // Simulate a crash right after the persistent pointer switched but before
  // acknowledgement/idempotency completion.
  hosted.rollout.hooks.afterPointerSwitch = () => {
    throw new Error("simulated crash after pointer switch");
  };
  const failed = await request(hosted, "/v1/rollout/submit", {
    method: "POST", token: WRITE_TOKEN, key: "sub-fault-0001", body: submitBody,
  });
  assert.equal(failed.response.status, 500);
  // The publication DID commit durably.
  const afterCrash = await request(hosted, "/v1/rollout/status", { token: READ_TOKEN });
  assert.equal(afterCrash.payload.revision, digestToRevision(files));
  delete hosted.rollout.hooks.afterPointerSwitch;

  // Same key retries return the actual committed result.
  const retried = await request(hosted, "/v1/rollout/submit", {
    method: "POST", token: WRITE_TOKEN, key: "sub-fault-0001", body: submitBody,
  });
  assert.equal(retried.response.status, 200);
  assert.equal(retried.payload.published, true);
  assert.equal(retried.payload.recovered || retried.payload.replayed, true);
  assert.equal(retried.payload.revision, afterCrash.payload.revision);
  void root;
});

test("restart recovery replays a committed-but-unacknowledged submission", async (t) => {
  const root = fixture();
  const common = { rootPath: root, port: 0, readToken: READ_TOKEN, writeToken: WRITE_TOKEN };
  const first = await runHostedServer(common);
  const snapshot = (await request(first, "/v1/rollout/snapshot", { token: WRITE_TOKEN })).payload;
  const files = snapshot.files.map(({ path: filePath, content }) => ({ path: filePath, content }));
  files.push({ path: "beta.md", content: "---\ntype: Spec\ntitle: Beta\n---\n\n# Beta\n" });
  const body = { bundle: snapshot.bundle, baseRevision: snapshot.revision, candidateDigest: digest(files), files };
  const dry = (await request(first, "/v1/rollout/dry-run", {
    method: "POST", token: WRITE_TOKEN, key: "dry-restart-001", body,
  })).payload;
  first.rollout.hooks.beforeIdempotencySave = () => {
    throw new Error("simulated crash before idempotency save");
  };
  const failed = await request(first, "/v1/rollout/submit", {
    method: "POST", token: WRITE_TOKEN, key: "sub-restart-001",
    body: Object.assign({}, body, { previewId: dry.previewId, confirmed: true }),
  });
  assert.equal(failed.response.status, 500);
  await first.handler.close();
  await new Promise((resolve) => first.server.close(resolve));

  // A fresh process over the same store recovers the committed result.
  const second = await runHostedServer(common);
  try {
    const retried = await request(second, "/v1/rollout/submit", {
      method: "POST", token: WRITE_TOKEN, key: "sub-restart-001",
      body: Object.assign({}, body, { previewId: dry.previewId, confirmed: true }),
    });
    assert.equal(retried.response.status, 200);
    assert.equal(retried.payload.published, true);
    assert.equal(retried.payload.recovered || retried.payload.replayed, true);
    const status = await request(second, "/v1/rollout/status", { token: READ_TOKEN });
    assert.equal(status.payload.revision, retried.payload.revision);
  } finally {
    await second.handler.close();
    await new Promise((resolve) => second.server.close(resolve));
  }
});

test("opt-in compatibility mirror rejects symlinked parent chains and never blocks serving", async (t) => {
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "okf-mirror-outside-")));
  const { root, hosted } = await start(t, { materialize: true });
  fs.symlinkSync(outside, path.join(root, "escape"));
  const snapshot = (await request(hosted, "/v1/rollout/snapshot", { token: WRITE_TOKEN })).payload;
  const files = snapshot.files.map(({ path: filePath, content }) => ({ path: filePath, content }));
  files.push({ path: "escape/evil.md", content: "---\ntype: Spec\ntitle: Evil\n---\n\n# Evil\n" });
  const body = { bundle: snapshot.bundle, baseRevision: snapshot.revision, candidateDigest: digest(files), files };
  const dry = (await request(hosted, "/v1/rollout/dry-run", {
    method: "POST", token: WRITE_TOKEN, key: "dry-mirror-0001", body,
  })).payload;
  const submitted = await request(hosted, "/v1/rollout/submit", {
    method: "POST", token: WRITE_TOKEN, key: "sub-mirror-0001",
    body: Object.assign({}, body, { previewId: dry.previewId, confirmed: true }),
  });
  assert.equal(submitted.response.status, 200);
  assert.equal(submitted.payload.materialization.applied, false);
  assert.match(submitted.payload.materialization.reason, /symbolic link|outside/i);
  // Serving still comes from the generation store.
  const served = await request(hosted, "/v1/rollout/snapshot", { token: READ_TOKEN });
  assert.ok(served.payload.files.some((file) => file.path === "escape/evil.md"));
  assert.equal(fs.existsSync(path.join(outside, "evil.md")), false);
});

test("startup integrity: corrupt active falls back; all-corrupt refuses startup", async (t) => {
  const root = fixture();
  const common = { rootPath: root, port: 0, readToken: READ_TOKEN, writeToken: WRITE_TOKEN };
  const first = await runHostedServer(common);
  const original = (await request(first, "/v1/rollout/snapshot", { token: READ_TOKEN })).payload;
  const files = original.files.map(({ path: filePath, content }) => ({ path: filePath, content }));
  files.push({ path: "beta.md", content: "---\ntype: Spec\ntitle: Beta\n---\n\n# Beta\n" });
  const body = { bundle: original.bundle, baseRevision: original.revision, candidateDigest: digest(files), files };
  const dry = (await request(first, "/v1/rollout/dry-run", {
    method: "POST", token: WRITE_TOKEN, key: "dry-integrity-01", body,
  })).payload;
  await request(first, "/v1/rollout/submit", {
    method: "POST", token: WRITE_TOKEN, key: "sub-integrity-01",
    body: Object.assign({}, body, { previewId: dry.previewId, confirmed: true }),
  });
  const generationDir = first.manager.filesDir(original.bundle, (await request(first, "/v1/rollout/status", { token: READ_TOKEN })).payload.generationId);
  await first.handler.close();
  await new Promise((resolve) => first.server.close(resolve));

  // Corrupt only the ACTIVE generation: restart must fall back to the
  // previous verified generation.
  fs.appendFileSync(path.join(generationDir, "beta.md"), "tampered bytes\n", "utf8");
  const second = await runHostedServer(common);
  const fallback = await request(second, "/v1/rollout/snapshot", { token: READ_TOKEN });
  assert.equal(fallback.response.status, 200);
  assert.equal(fallback.payload.revision, original.revision);
  assert.equal(fallback.payload.files.length, 1);
  const activeGenerationDir = second.manager.filesDir(original.bundle, fallback.payload.generationId);
  await second.handler.close();
  await new Promise((resolve) => second.server.close(resolve));

  // Corrupt every retained generation: startup is refused outright.
  for (const entry of fs.readdirSync(path.dirname(path.dirname(activeGenerationDir)), { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const alphaPath = path.join(path.dirname(path.dirname(activeGenerationDir)), entry.name, "files", "alpha.md");
    if (fs.existsSync(alphaPath)) {
      fs.appendFileSync(alphaPath, "tampered\n", "utf8");
    }
  }
  await assert.rejects(() => runHostedServer(common), /integrity|Refusing startup/i);
});

function digestToRevision(files) {
  const manifest = files.map((file) => ({
    path: file.path,
    sha256: crypto.createHash("sha256").update(file.content).digest("hex"),
  })).sort((a, b) => a.path.localeCompare(b.path));
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex")}`;
}

test("dry-run returns a bounded server-generated diff for add, update, and delete", async (t) => {
  const { hosted } = await start(t);
  const snapshot = (await request(hosted, "/v1/rollout/snapshot", { token: WRITE_TOKEN })).payload;
  const original = snapshot.files.find((file) => file.path === "alpha.md").content;

  // Update + add
  const withChanges = [
    { path: "alpha.md", content: original.replace("# Alpha", "# Alpha rewritten") },
    { path: "beta.md", content: "---\ntype: Spec\ntitle: Beta\n---\n\n# Beta\n" },
  ];
  const dry = (await request(hosted, "/v1/rollout/dry-run", {
    method: "POST", token: WRITE_TOKEN, key: "dry-diff-add-001",
    body: { bundle: snapshot.bundle, baseRevision: snapshot.revision, candidateDigest: digest(withChanges), files: withChanges },
  })).payload;
  assert.match(dry.diffText, /--- Updated: alpha\.md ---/);
  assert.match(dry.diffText, /-# Alpha/);
  assert.match(dry.diffText, /\+# Alpha rewritten/);
  assert.match(dry.diffText, /--- Added: beta\.md ---/);
  assert.match(dry.diffText, /\+# Beta/);
  assert.equal(dry.diffTruncated, false);

  // Delete: candidate drops beta.md entirely.
  const afterPublish = (await request(hosted, "/v1/rollout/status", { token: READ_TOKEN }));
  void afterPublish;
  const submit = await request(hosted, "/v1/rollout/submit", {
    method: "POST", token: WRITE_TOKEN, key: "sub-diff-add-001",
    body: {
      bundle: snapshot.bundle,
      baseRevision: snapshot.revision,
      candidateDigest: digest(withChanges),
      files: withChanges,
      previewId: dry.previewId,
      confirmed: true,
    },
  });
  assert.equal(submit.response.status, 200);
  const newSnapshot = (await request(hosted, "/v1/rollout/snapshot", { token: WRITE_TOKEN })).payload;
  const removal = [{ path: "alpha.md", content: original }];
  const removalDry = (await request(hosted, "/v1/rollout/dry-run", {
    method: "POST", token: WRITE_TOKEN, key: "dry-diff-del-001",
    body: {
      bundle: snapshot.bundle,
      baseRevision: submit.payload.revision,
      candidateDigest: digest(removal),
      files: removal,
    },
  })).payload;
  assert.match(removalDry.diffText, /--- Removed: beta\.md ---/);
  assert.match(removalDry.diffText, /-# Beta/);
});

test("diff output is bounded per file and in total with explicit truncation markers", async (t) => {
  const { hosted } = await start(t, { diffPerFileLimitBytes: 512, diffTotalLimitBytes: 1024 });
  const snapshot = (await request(hosted, "/v1/rollout/snapshot", { token: WRITE_TOKEN })).payload;

  // One updated file whose changed middle alone exceeds the per-file limit.
  const bigBody = Array.from({ length: 200 }, (_unused, index) => `changed line ${index}`).join("\n");
  const perFileOnly = [{
    path: "alpha.md",
    content: `---\ntype: Spec\ntitle: Alpha\n---\n\n# Alpha\n\n${bigBody}\n`,
  }];
  const perFileDry = (await request(hosted, "/v1/rollout/dry-run", {
    method: "POST", token: WRITE_TOKEN, key: "dry-trunc-file-01",
    body: { bundle: snapshot.bundle, baseRevision: snapshot.revision, candidateDigest: digest(perFileOnly), files: perFileOnly },
  })).payload;
  assert.equal(perFileDry.diffTruncated, true);
  assert.match(perFileDry.diffText, /\[\.\.\. diff truncated for alpha\.md \.\.\.\]/);

  // Many changed files exceed the total limit; later sections are omitted.
  const manyFiles = [];
  for (let index = 0; index < 12; index += 1) {
    manyFiles.push({
      path: `doc-${String(index).padStart(2, "0")}.md`,
      content: `---\ntype: Spec\ntitle: Doc ${index}\n---\n\n# Doc ${index}\n\n${bigBody}\n`,
    });
  }
  const totalDry = (await request(hosted, "/v1/rollout/dry-run", {
    method: "POST", token: WRITE_TOKEN, key: "dry-trunc-total-1",
    body: { bundle: snapshot.bundle, baseRevision: snapshot.revision, candidateDigest: digest(manyFiles), files: manyFiles },
  })).payload;
  assert.equal(totalDry.diffTruncated, true);
  assert.match(totalDry.diffText, /more changed file\(s\) omitted/);
  assert.ok(Buffer.byteLength(totalDry.diffText, "utf8") <= 2048, "total diff stays near the configured bound");
});
