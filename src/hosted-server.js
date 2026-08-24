"use strict";

// Combined hosted mode: ordinary rollout REST (/v1/rollout/*) and MCP
// Streamable HTTP (/mcp) share one Node server, one GenerationManager, and
// one active index. The central hosted profile mounts no proposal API and
// disables authoring, live MCP writes, and runtime remote loads.

const http = require("node:http");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const { createMcpHandler } = require("@modelcontextprotocol/server");
const { buildIndex, attachProject } = require("./indexer");
const { FileConceptStore } = require("./store");
const { GenerationManager } = require("./generation-manager");
const { SnapshotRolloutService, principalFromToken } = require("./snapshot");
const { createState, registerMcpInterface } = require("./mcp-server");

function timingSafeEqualStrings(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  if (a.length !== b.length) {
    // Still perform a comparison to keep timing flat-ish.
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function bearerToken(req) {
  const header = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : "";
}

function sendJson(res, status, value) {
  const text = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

async function readBody(req, limit) {
  const maxBytes = limit || 8 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error("Request body exceeds byte limit."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      if (!text.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (_error) {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function buildGenerationIndex(store, manager) {
  const bundleArgs = store.getBundles().map((bundle) => ({
    id: bundle.id,
    root: manager.filesDir(bundle.id, manager.getActive(bundle.id).generationId),
    include: bundle.include || [],
    exclude: bundle.exclude || [],
  }));
  let index = buildIndex(bundleArgs, {
    relationTypes: store.getRelationTypes(),
    strictLinks: store.strictLinks,
    allowCustomRelationTypes: store.allowCustomRelationTypes,
  });
  if (store.project) {
    index = attachProject(index, store.project);
  }
  return { index, bundleArgs };
}

async function runHostedServer(options) {
  const config = options || {};
  const store = config.store || (config.rootPath
    ? FileConceptStore.fromRoot(config.rootPath, {
      proposalRoot: config.proposalRoot,
      strictLinks: config.strictLinks,
    })
    : FileConceptStore.fromProject(config.projectPath, { proposalRoot: config.proposalRoot }));

  const writeToken = String(config.writeToken || "");
  const readToken = String(config.readToken || "");
  if (!writeToken || !readToken) {
    throw new Error("Hosted mode requires both OKF_READ_TOKEN and OKF_ROLLOUT_TOKEN (bearer auth is mandatory).");
  }
  if (timingSafeEqualStrings(writeToken, readToken)) {
    throw new Error("Hosted mode requires distinct read and rollout tokens.");
  }

  const manager = new GenerationManager(store, {
    generationsRoot: config.generationsRoot,
    previewTtlMs: config.previewTtlMs,
    // Compatibility mirror is opt-in; serving always uses the generation store.
    materialize: config.materialize === true,
  });
  // Seed/recover every writable bundle with full integrity verification
  // before serving; refuses startup when nothing verifies.
  manager.seedAll();

  const buildIndexForActiveGenerations = () => buildGenerationIndex(store, manager);
  const initial = buildIndexForActiveGenerations();
  const mcpState = createState(initial.bundleArgs, {
    initialIndex: initial.index,
    relationTypes: store.getRelationTypes(),
    strictLinks: store.strictLinks,
    allowCustomRelationTypes: store.allowCustomRelationTypes,
    repositoryMappings: config.repositoryMappings,
    // Central hosted profile: no authoring service, no live writes, no
    // runtime remote load. Only read-only tools are registered.
  });

  const rollout = new SnapshotRolloutService(store, {
    manager,
    diffPerFileLimitBytes: config.diffPerFileLimitBytes,
    diffTotalLimitBytes: config.diffTotalLimitBytes,
    onPublished: ({ index, bundleArgs }) => {
      // Activation boundary: swap the already-built, validated index without
      // rebuilding. New MCP requests immediately observe the activated
      // generation; in-flight requests retain the previous index object.
      mcpState.index = index;
      mcpState.localBundleArgs = bundleArgs;
    },
  });

  const handler = createMcpHandler(() => registerMcpInterface(mcpState), {
    onerror: (error) => {
      process.stderr.write(`okf-mcp hosted MCP handler error: ${error && error.message ? error.message : error}\n`);
    },
  });

  function authenticateMcp(req) {
    const token = bearerToken(req);
    if (!token) {
      return { status: 401, error: "Unauthorized: MCP access requires a bearer token." };
    }
    // MCP accepts only the read token; the rollout write token is for
    // /v1/rollout mutations exclusively.
    if (!timingSafeEqualStrings(token, readToken)) {
      return { status: 403, error: "Forbidden: MCP access requires the read token." };
    }
    return { status: 0 };
  }

  async function handleRollout(req, res, url, pathname) {
    const token = bearerToken(req);
    if (!token) {
      sendJson(res, 401, { error: "Unauthorized: a bearer token is required." });
      return;
    }
    const isReadToken = Boolean(readToken) && timingSafeEqualStrings(token, readToken);
    const isWriteToken = Boolean(writeToken) && timingSafeEqualStrings(token, writeToken);
    if (!isReadToken && !isWriteToken) {
      sendJson(res, 403, { error: "Forbidden: the supplied token was rejected." });
      return;
    }
    const principal = principalFromToken(isWriteToken ? writeToken : readToken, process.env);
    const idempotencyKey = req.headers["idempotency-key"] || "";

    if (req.method === "GET" && pathname === "/v1/rollout/snapshot") {
      const snapshot = rollout.currentSnapshot(url.searchParams.get("bundle") || "");
      sendJson(res, 200, {
        bundle: snapshot.bundle,
        revision: snapshot.revision,
        generationId: snapshot.generationId,
        generatedAt: snapshot.generatedAt,
        fileCount: snapshot.fileCount,
        persistence: snapshot.persistence,
        files: snapshot.files.map((file) => ({
          path: file.path,
          content: file.content,
          sha256: file.sha256,
          bytes: file.bytes,
        })),
      });
      return;
    }
    if (req.method === "GET" && pathname === "/v1/rollout/status") {
      sendJson(res, 200, rollout.status(url.searchParams.get("bundle") || ""));
      return;
    }
    if (!isWriteToken) {
      sendJson(res, 403, { error: "Forbidden: rollout mutations require the rollout write token." });
      return;
    }
    if (req.method === "POST" && pathname === "/v1/rollout/dry-run") {
      const result = await rollout.dryRun(await readBody(req), principal, idempotencyKey);
      sendJson(res, 200, result);
      return;
    }
    if (req.method === "POST" && pathname === "/v1/rollout/submit") {
      const result = await rollout.submit(await readBody(req), principal, idempotencyKey);
      sendJson(res, 200, result);
      return;
    }
    sendJson(res, 404, { error: "Not found." });
  }

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    try {
      if (req.method === "GET" && pathname === "/health") {
        sendJson(res, 200, { ok: true, mode: "hosted" });
        return;
      }
      if (pathname.startsWith("/v1/rollout")) {
        await handleRollout(req, res, url, pathname);
        return;
      }
      if (pathname === "/mcp") {
        const auth = authenticateMcp(req);
        if (auth.status) {
          sendJson(res, auth.status, { error: auth.error });
          return;
        }
        const origin = `http://${req.headers.host || "localhost"}`;
        const headers = new Headers();
        Object.entries(req.headers).forEach(([name, value]) => {
          if (value === undefined) return;
          if (Array.isArray(value)) value.forEach((entry) => headers.append(name, entry));
          else headers.set(name, String(value));
        });
        const init = { method: req.method, headers, duplex: "half" };
        if (!["GET", "HEAD"].includes(req.method)) {
          init.body = Readable.toWeb(req);
        }
        const response = await handler.fetch(new Request(url, init));
        const responseHeaders = {};
        response.headers.forEach((value, name) => {
          responseHeaders[name] = value;
        });
        res.writeHead(response.status, responseHeaders);
        if (response.body) {
          const stream = Readable.fromWeb(response.body);
          stream.on("error", () => {
            if (!res.writableEnded) res.end();
          });
          stream.pipe(res);
        } else {
          res.end();
        }
        return;
      }
      sendJson(res, 404, { error: "Not found." });
    } catch (error) {
      // Domain errors carry explicit status codes; anything else is an
      // unexpected failure (e.g. a simulated crash) and maps to 500.
      const domainError = error && /^Snapshot[A-Za-z]*Error$/.test(String(error.name || ""));
      sendJson(res, error.statusCode || (domainError ? 400 : 500), {
        error: error.message || String(error),
        ...(error.details !== undefined ? { details: error.details } : {}),
      });
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: error && error.message ? error.message : "Internal error." });
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });
  const host = config.host || "127.0.0.1";
  const port = config.port === undefined || config.port === "" ? 8790 : Number(config.port);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return {
    server,
    handler,
    manager,
    rollout,
    state: mcpState,
    url: `http://${host}:${server.address().port}`,
  };
}

module.exports = {
  runHostedServer,
};
