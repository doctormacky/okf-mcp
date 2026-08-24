"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { Client, StreamableHTTPClientTransport } = require("@modelcontextprotocol/client");
const { runHostedServer } = require("../src/hosted-server");
const { connectMcp } = require("./mcp-client");
const { main } = require("../src/cli");

const READ_TOKEN = "hosted-read-token";
const WRITE_TOKEN = "hosted-write-token";

function rootFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "okf-hosted-e2e-")));
  fs.writeFileSync(path.join(root, "alpha.md"), "---\ntype: Spec\ntitle: Alpha\ndescription: Original alpha\n---\n\n# Alpha\n", "utf8");
  return root;
}

function candidateDigest(files) {
  const manifest = files.map((file) => ({
    path: file.path,
    sha256: crypto.createHash("sha256").update(file.content).digest("hex"),
  })).sort((a, b) => a.path.localeCompare(b.path));
  return crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

async function connect(url, token) {
  const client = new Client({ name: "hosted-test", version: "1" }, { versionNegotiation: { mode: "legacy" } });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: token ? { authorization: `Bearer ${token}` } : {} },
  });
  await client.connect(transport);
  return client;
}

async function rollout(hosted, pathname, method, body, key) {
  const response = await fetch(`${hosted.url}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${WRITE_TOKEN}`,
      "content-type": "application/json",
      ...(key ? { "idempotency-key": key } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const payload = JSON.parse(await response.text());
  return { response, payload };
}

function canonicalTools(result) {
  return result.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    annotations: tool.annotations || null,
    inputSchema: tool.inputSchema,
  })).sort((a, b) => a.name.localeCompare(b.name));
}

test("hosted MCP requires auth and preserves canonical stdio interface parity", async (t) => {
  const root = rootFixture();
  const stdio = await connectMcp(t, [root], {});
  const stdioTools = canonicalTools(await stdio.client.listTools());
  const stdioResources = await stdio.client.listResources();
  const stdioTemplates = await stdio.client.listResourceTemplates();
  const hosted = await runHostedServer({ rootPath: root, port: 0, readToken: READ_TOKEN, writeToken: WRITE_TOKEN });
  t.after(async () => {
    await hosted.handler.close();
    await new Promise((resolve) => hosted.server.close(resolve));
  });

  const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "raw", version: "1" } } };
  const unauth = await fetch(`${hosted.url}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(initialize) });
  assert.equal(unauth.status, 401);
  const forbidden = await fetch(`${hosted.url}/mcp`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer wrong" }, body: JSON.stringify(initialize) });
  assert.equal(forbidden.status, 403);

  const httpClient = await connect(hosted.url, READ_TOKEN);
  t.after(() => httpClient.close());
  assert.deepEqual(canonicalTools(await httpClient.listTools()), stdioTools);
  assert.deepEqual(await httpClient.listResources(), stdioResources);
  assert.deepEqual(await httpClient.listResourceTemplates(), stdioTemplates);

  const unknown = await httpClient.callTool({ name: "does_not_exist", arguments: {} }).catch((error) => error);
  assert.ok(unknown instanceof Error || unknown.isError === true);
});

test("submit activation immediately refreshes MCP while in-flight readers retain their generation", async (t) => {
  const root = rootFixture();
  const hosted = await runHostedServer({ rootPath: root, port: 0, readToken: READ_TOKEN, writeToken: WRITE_TOKEN });
  t.after(async () => {
    await hosted.handler.close();
    await new Promise((resolve) => hosted.server.close(resolve));
  });
  const firstClient = await connect(hosted.url, READ_TOKEN);
  const secondClient = await connect(hosted.url, READ_TOKEN);
  t.after(() => firstClient.close());
  t.after(() => secondClient.close());

  // The rollout write token is rejected for MCP access.
  await assert.rejects(
    connect(hosted.url, WRITE_TOKEN),
    (error) => /403|Forbidden/i.test(String(error && error.message)),
  );

  const snapshotResponse = await fetch(`${hosted.url}/v1/rollout/snapshot`, { headers: { authorization: `Bearer ${WRITE_TOKEN}` } });
  const snapshot = await snapshotResponse.json();
  const files = snapshot.files.map(({ path: filePath, content }) => ({ path: filePath, content }));
  files.push({ path: "beta.md", content: "---\ntype: Spec\ntitle: Beta\ndescription: Newly published beta\n---\n\n# Beta\n" });
  const body = { bundle: snapshot.bundle, baseRevision: snapshot.revision, candidateDigest: candidateDigest(files), files };
  const dry = await rollout(hosted, "/v1/rollout/dry-run", "POST", body, "dry-hosted-e2e-1");
  assert.equal(dry.response.status, 200);

  // Pause one real MCP call after it captures the current index reference.
  const previousIndex = hosted.state.index;
  let releaseRead;
  const readGate = new Promise((resolve) => { releaseRead = resolve; });
  let capturedRead;
  const captured = new Promise((resolve) => { capturedRead = resolve; });
  hosted.state.beforeToolCall = async ({ name, index }) => {
    if (name === "search_concepts") {
      capturedRead(index);
      await readGate;
    }
  };
  const inFlightSearch = firstClient.callTool({ name: "search_concepts", arguments: { query: "Newly published beta" } });
  const inFlightIndex = await captured;
  assert.equal(inFlightIndex, previousIndex);

  const submit = await rollout(hosted, "/v1/rollout/submit", "POST", Object.assign({}, body, {
    previewId: dry.payload.previewId,
    confirmed: true,
  }), "sub-hosted-e2e-1");
  assert.equal(submit.response.status, 200);
  assert.notEqual(hosted.state.index, previousIndex);
  assert.equal(previousIndex.concepts.some((doc) => doc.title === "Beta"), false);
  assert.equal(hosted.state.index.concepts.some((doc) => doc.title === "Beta"), true);

  releaseRead();
  const oldSearchPayload = JSON.parse((await inFlightSearch).content[0].text);
  assert.equal(oldSearchPayload.results.some((entry) => entry.title === "Beta"), false);
  hosted.state.beforeToolCall = null;

  const search = await firstClient.callTool({ name: "search_concepts", arguments: { query: "Newly published beta" } });
  const searchPayload = JSON.parse(search.content[0].text);
  assert.equal(searchPayload.results.some((entry) => entry.title === "Beta"), true);

  const get = await secondClient.callTool({ name: "get_concept", arguments: { id: "beta" } });
  assert.equal(JSON.parse(get.content[0].text).title, "Beta");
});

test("hosted token separation: identical tokens refused, write token never grants MCP", async (t) => {
  const root = rootFixture();
  await assert.rejects(
    () => runHostedServer({ rootPath: root, port: 0, readToken: "same", writeToken: "same" }),
    /distinct read and rollout tokens/,
  );
  await assert.rejects(
    () => runHostedServer({ rootPath: root, port: 0, readToken: "only-read", writeToken: "" }),
    /both OKF_READ_TOKEN and OKF_ROLLOUT_TOKEN/,
  );

  const hosted = await runHostedServer({ rootPath: root, port: 0, readToken: READ_TOKEN, writeToken: WRITE_TOKEN });
  try {
    const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "raw", version: "1" } } };
    const unauth = await fetch(`${hosted.url}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(initialize) });
    assert.equal(unauth.status, 401);
    const writeTokenMcp = await fetch(`${hosted.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${WRITE_TOKEN}` },
      body: JSON.stringify(initialize),
    });
    assert.equal(writeTokenMcp.status, 403);

    // The read token can read rollout state but can never mutate.
    const status = await fetch(`${hosted.url}/v1/rollout/status`, { headers: { authorization: `Bearer ${READ_TOKEN}` } });
    assert.equal(status.status, 200);
    const dryRun = await fetch(`${hosted.url}/v1/rollout/dry-run`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${READ_TOKEN}`, "idempotency-key": "dry-denied-001" },
      body: JSON.stringify({}),
    });
    assert.equal(dryRun.status, 403);
  } finally {
    await hosted.handler.close();
    await new Promise((resolve) => hosted.server.close(resolve));
  }
});

test("standalone mcp --http refuses non-loopback hosts without --insecure-http", async (t) => {
  const { parseArgs } = require("../src/cli");
  assert.equal(parseArgs(["--http", "--insecure-http"]).insecureHttp, true);
  assert.equal(parseArgs(["--http"]).insecureHttp, false);

  const root = rootFixture();
  await assert.rejects(
    main(["--root", root, "--host", "0.0.0.0", "mcp", "--http"]),
    /refuses non-loopback hosts/,
  );
  await assert.rejects(
    main(["--root", root, "--host", "192.168.1.10", "mcp", "--http"]),
    /refuses non-loopback hosts/,
  );

  let called = null;
  await main(["--root", root, "--host", "0.0.0.0", "--insecure-http", "mcp", "--http"], {
    cwd: os.tmpdir(),
    runStreamableHttpServer: async (bundles, options) => {
      called = { bundles, options };
      return { url: "http://0.0.0.0:0/mcp", close: async () => {} };
    },
  });
  assert.equal(called.options.host, "0.0.0.0");

  // Loopback default remains allowed without the flag.
  await main(["--root", root, "mcp", "--http"], {
    cwd: os.tmpdir(),
    runStreamableHttpServer: async (bundles, options) => {
      called = { bundles, options };
      return { url: "http://127.0.0.1:0/mcp" };
    },
  });
  assert.equal(called.options.host, "127.0.0.1");
});
