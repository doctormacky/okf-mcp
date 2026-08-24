"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { runHostedServer } = require("../src/hosted-server");
const { KnowledgeHttpError, WORKSPACE_STATE_FILE } = require("../src/knowledge-client");
const { main } = require("../src/cli");

const READ_TOKEN = "cli-read-token";
const WRITE_TOKEN = "cli-write-token";

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "okf-cli-hosted-")));
  fs.writeFileSync(path.join(root, "alpha.md"), "---\ntype: Spec\ntitle: Alpha\n---\n\n# Alpha\n", "utf8");
  return root;
}

function runtime(env) {
  const chunks = [];
  return {
    value: {
      cwd: os.tmpdir(),
      env,
      stdin: { readable: false, on() {}, removeListener() {} },
      stdout: { write(chunk) { chunks.push(String(chunk)); return true; } },
    },
    output: () => chunks.join(""),
  };
}

async function start(t) {
  const root = fixture();
  const hosted = await runHostedServer({ rootPath: root, port: 0, readToken: READ_TOKEN, writeToken: WRITE_TOKEN });
  t.after(async () => {
    await hosted.handler.close();
    await new Promise((resolve) => hosted.server.close(resolve));
  });
  return { root, hosted };
}

test("knowledge CLI safely downloads, previews, confirms, publishes and removes stale files", async (t) => {
  const { root, hosted } = await start(t);
  const workspace = path.join(os.tmpdir(), `okf-cli-workspace-${process.pid}-${Date.now()}`);
  const env = { OKF_ROLLOUT_TOKEN: WRITE_TOKEN };

  let capture = runtime(env);
  await main(["knowledge", "download", "--out", workspace, "--url", hosted.url, "--json"], capture.value);
  const downloaded = JSON.parse(capture.output());
  assert.equal(downloaded.fileCount, 1);
  assert.equal(fs.statSync(path.join(workspace, WORKSPACE_STATE_FILE)).mode & 0o777, 0o600);

  // Repeat download swaps the whole workspace and removes stale Markdown.
  fs.writeFileSync(path.join(workspace, "stale.md"), "# stale\n", "utf8");
  capture = runtime(env);
  await main(["knowledge", "download", workspace, "--url", hosted.url, "--json"], capture.value);
  assert.equal(fs.existsSync(path.join(workspace, "stale.md")), false);

  fs.writeFileSync(path.join(workspace, "beta.md"), "---\ntype: Spec\ntitle: Beta\n---\n\n# Beta\n", "utf8");
  capture = runtime(env);
  await main(["knowledge", "submit", "--workspace", workspace, "--dry-run", "--json"], capture.value);
  const dry = JSON.parse(capture.output());
  assert.equal(dry.valid, true);
  assert.match(dry.previewId, /^pv_/);
  const previewState = JSON.parse(fs.readFileSync(path.join(workspace, WORKSPACE_STATE_FILE), "utf8"));
  assert.equal(previewState.preview.previewId, dry.previewId);
  assert.ok(previewState.pendingDryRun.key);

  capture = runtime(env);
  await main(["knowledge", "submit", workspace, "--yes", "--preview-id", dry.previewId, "--json"], capture.value);
  const submitted = JSON.parse(capture.output());
  assert.equal(submitted.published, true);
  // Compatibility mirror is opt-in: the mutable root is untouched by default.
  assert.equal(fs.existsSync(path.join(root, "beta.md")), false);
  const finalState = JSON.parse(fs.readFileSync(path.join(workspace, WORKSPACE_STATE_FILE), "utf8"));
  assert.equal(finalState.revision, submitted.revision);
  assert.equal(finalState.preview, null);
  assert.equal(finalState.pendingSubmit, null);

  capture = runtime(env);
  await main(["knowledge", "status", "--url", hosted.url, "--json"], capture.value);
  assert.equal(JSON.parse(capture.output()).revision, submitted.revision);
});

test("messageless dry-run previews submit cleanly with a message; --preview-id is strict", async (t) => {
  const { root, hosted } = await start(t);
  const workspace = path.join(os.tmpdir(), `okf-cli-preview-${process.pid}-${Date.now()}`);
  const env = { OKF_ROLLOUT_TOKEN: WRITE_TOKEN };

  let capture = runtime(env);
  await main(["knowledge", "download", workspace, "--url", hosted.url], capture.value);
  fs.writeFileSync(path.join(workspace, "beta.md"), "---\ntype: Spec\ntitle: Beta\n---\n\n# Beta\n", "utf8");

  // Standard dry-run without a message...
  capture = runtime(env);
  await main(["knowledge", "submit", workspace, "--dry-run", "--json"], capture.value);
  const dry = JSON.parse(capture.output());
  assert.match(dry.previewId, /^pv_/);

  // ...must be submittable with a message afterwards.
  capture = runtime(env);
  await main(["knowledge", "submit", workspace, "--yes", "--json", "--message", "add beta later"], capture.value);
  const submitted = JSON.parse(capture.output());
  assert.equal(submitted.published, true);

  // A second change with an explicit --preview-id must match the persisted
  // preview exactly: wrong id or changed workspace are rejected up front.
  fs.writeFileSync(path.join(workspace, "gamma.md"), "---\ntype: Spec\ntitle: Gamma\n---\n\n# Gamma\n", "utf8");
  await assert.rejects(
    main(["knowledge", "submit", workspace, "--yes", "--preview-id", "pv_" + "0".repeat(32), "--json"], runtime(env).value),
    /does not match the persisted preview/,
  );
  capture = runtime(env);
  await main(["knowledge", "submit", workspace, "--dry-run", "--json"], capture.value);
  const dry2 = JSON.parse(capture.output());
  fs.writeFileSync(path.join(workspace, "gamma.md"), "---\ntype: Spec\ntitle: Gamma changed\n---\n\n# Gamma\n", "utf8");
  await assert.rejects(
    main(["knowledge", "submit", workspace, "--yes", "--preview-id", dry2.previewId, "--json"], runtime(env).value),
    /workspace changed since this preview/,
  );
  void root;
});

test("knowledge CLI requires auth, rejects symlinked workspaces, and hosted CLI rejects central writes", async (t) => {
  const { hosted } = await start(t);
  const workspace = path.join(os.tmpdir(), `okf-cli-auth-${process.pid}-${Date.now()}`);
  await assert.rejects(
    main(["knowledge", "download", workspace, "--url", hosted.url], runtime({}).value),
    (error) => error instanceof KnowledgeHttpError && error.statusCode === 401,
  );
  await assert.rejects(
    main(["knowledge", "status", "--url", hosted.url], runtime({ OKF_READ_TOKEN: "wrong" }).value),
    (error) => error instanceof KnowledgeHttpError && error.statusCode === 403,
  );

  await main(["knowledge", "download", workspace, "--url", hosted.url], runtime({ OKF_READ_TOKEN: READ_TOKEN }).value);
  const linkTarget = path.join(os.tmpdir(), `okf-cli-link-target-${process.pid}`);
  fs.writeFileSync(linkTarget, "x", "utf8");
  fs.symlinkSync(linkTarget, path.join(workspace, "unsafe-link"));
  await assert.rejects(
    main(["knowledge", "download", workspace, "--url", hosted.url], runtime({ OKF_READ_TOKEN: READ_TOKEN }).value),
    /symbolic link/,
  );

  let hostedCall = false;
  await assert.rejects(
    main(["--root", fixture(), "--authoring", "hosted"], {
      cwd: os.tmpdir(),
      env: { OKF_READ_TOKEN: READ_TOKEN, OKF_ROLLOUT_TOKEN: WRITE_TOKEN },
      runHostedServer: async () => { hostedCall = true; },
    }),
    /central read-only MCP profile/,
  );
  assert.equal(hostedCall, false);
});

test("CLI dry-run prints the server diff before confirmation and JSON carries it", async (t) => {
  const { hosted } = await start(t);
  const workspace = path.join(os.tmpdir(), `okf-cli-diff-${process.pid}-${Date.now()}`);
  const env = { OKF_ROLLOUT_TOKEN: WRITE_TOKEN };

  let capture = runtime(env);
  await main(["knowledge", "download", workspace, "--url", hosted.url], capture.value);
  fs.writeFileSync(path.join(workspace, "alpha.md"), "---\ntype: Spec\ntitle: Alpha rewritten\n---\n\n# Alpha rewritten\n", "utf8");

  // Human dry-run output shows the server-generated diff.
  capture = runtime(env);
  await main(["knowledge", "submit", workspace, "--dry-run"], capture.value);
  assert.match(capture.output(), /--- Proposed diff \(preview pv_[a-f0-9]+\) ---/);
  assert.match(capture.output(), /--- Updated: alpha\.md ---/);
  assert.match(capture.output(), /\+# Alpha rewritten/);
  assert.match(capture.output(), /--- End of proposed diff ---/);

  // JSON output carries the same diff fields.
  capture = runtime(env);
  await main(["knowledge", "submit", workspace, "--dry-run", "--json"], capture.value);
  const dry = JSON.parse(capture.output());
  assert.match(dry.diffText, /Updated: alpha\.md/);
  assert.equal(dry.diffTruncated, false);

  // Interactive submit (non-readable stdin declines) must still print the
  // diff and a prompt identifying preview and digest BEFORE confirmation.
  capture = runtime(env);
  await main(["knowledge", "submit", workspace], capture.value);
  const output = capture.output();
  const diffIndex = output.indexOf("--- Proposed diff");
  const promptIndex = output.indexOf("[y/N]");
  assert.ok(diffIndex >= 0, "diff is printed");
  assert.ok(promptIndex > diffIndex, "prompt follows the diff");
  assert.match(output, /preview pv_[a-f0-9]{32}/);
  assert.match(output, new RegExp(`digest ${dry.candidateDigest}`));
  assert.match(output, /Submission cancelled/);
});

test("CLI parsing accepts the documented quick commands", async (t) => {
  const { parseArgs } = require("../src/cli");

  const download = parseArgs([
    "knowledge", "download",
    "--url", "http://127.0.0.1:8790",
    "--out", "/tmp/ws",
  ]);
  assert.equal(download.positional[0], "knowledge");
  assert.equal(download.positional[1], "download");
  assert.equal(download.url, "http://127.0.0.1:8790");
  assert.equal(download.output, "/tmp/ws");

  const dryRun = parseArgs([
    "knowledge", "submit",
    "--workspace", "/tmp/ws",
    "--dry-run",
  ]);
  assert.equal(dryRun.positional[0], "knowledge");
  assert.equal(dryRun.positional[1], "submit");
  assert.equal(dryRun.output, "/tmp/ws");
  assert.equal(dryRun.dryRun, true);

  const submit = parseArgs([
    "knowledge", "submit",
    "--workspace", "/tmp/ws",
    "--preview-id", "pv_" + "a".repeat(32),
    "--message", "publish now",
  ]);
  assert.equal(submit.positional[1], "submit");
  assert.equal(submit.output, "/tmp/ws");
  assert.equal(submit.previewId, `pv_${"a".repeat(32)}`);
  assert.equal(submit.message, "publish now");

  // The documented quick commands execute end to end (--workspace form).
  const { hosted } = await start(t);
  const workspace = path.join(os.tmpdir(), `okf-cli-contract-${process.pid}-${Date.now()}`);
  let capture = runtime({ OKF_READ_TOKEN: READ_TOKEN });
  await main(["knowledge", "download", "--url", hosted.url, "--out", workspace, "--json"], capture.value);
  assert.equal(JSON.parse(capture.output()).action, "download");
  capture = runtime({ OKF_ROLLOUT_TOKEN: WRITE_TOKEN });
  fs.writeFileSync(path.join(workspace, "delta.md"), "---\ntype: Spec\ntitle: Delta\n---\n\n# Delta\n", "utf8");
  await main(["knowledge", "submit", "--workspace", workspace, "--dry-run", "--json"], capture.value);
  const contractDry = JSON.parse(capture.output());
  assert.equal(contractDry.action, "dry-run");
  assert.match(contractDry.diffText, /Added: delta\.md/);
});
