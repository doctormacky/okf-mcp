"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { Client } = require("@modelcontextprotocol/client");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/client");

const { runStreamableHttpServer } = require("../src/mcp-server");
const { connectMcp, callJson } = require("./mcp-client");

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "okf-mcp-http-"));
  fs.writeFileSync(path.join(root, "alpha.md"), [
    "---",
    "type: Spec",
    "title: Alpha",
    "description: MCP HTTP transport fixture",
    "---",
    "",
    "# Alpha",
    "",
    "- [Index](index.md)",
    "",
  ].join("\n"), "utf8");
  return root;
}

test("Streamable HTTP transport exposes the same tools and resources as stdio", async (t) => {
  const root = makeRoot();
  const httpServer = await runStreamableHttpServer([root], {});
  t.after(async () => {
    await httpServer.handler.close();
    await new Promise((resolve) => httpServer.server.close(resolve));
  });

  const client = new Client(
    { name: "okf-mcp-http-test", version: "1" },
    { versionNegotiation: { mode: "legacy" } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(httpServer.url));
  await client.connect(transport);
  t.after(() => client.close());

  const inMemory = await connectMcp(t, [root], {});

  // Tool listings must be identical across transports.
  const httpTools = (await client.listTools()).tools.map((tool) => tool.name).sort();
  const stdioTools = (await inMemory.client.listTools()).tools.map((tool) => tool.name).sort();
  assert.ok(httpTools.length > 0);
  assert.deepEqual(httpTools, stdioTools);

  // The same tool returns the same payload over both transports.
  const httpCall = await client.callTool({ name: "list_bundles", arguments: {} });
  const stdioCall = await callJson(inMemory.client, "list_bundles", {});
  assert.deepEqual(JSON.parse(httpCall.content[0].text), stdioCall.payload);

  // Resources are readable with canonical okf:// URIs.
  const resources = await client.listResources();
  assert.ok(resources.resources.length >= 1);
  const resource = resources.resources.find((entry) => /alpha/.test(entry.uri))
    || resources.resources[0];
  const read = await client.readResource({ uri: resource.uri });
  assert.equal(read.contents.length, 1);
  assert.match(read.contents[0].text, /title: Alpha/);

  // A second sequential session works against the same endpoint (stateless serving).
  const secondClient = new Client(
    { name: "okf-mcp-http-test-2", version: "1" },
    { versionNegotiation: { mode: "legacy" } },
  );
  const secondTransport = new StreamableHTTPClientTransport(new URL(httpServer.url));
  await secondClient.connect(secondTransport);
  const secondSummary = await secondClient.callTool({ name: "graph_summary", arguments: {} });
  assert.ok(secondSummary.content[0].text.includes("concept"));
  await secondClient.close();
});
