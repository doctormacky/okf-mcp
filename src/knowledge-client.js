"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const WORKSPACE_STATE_FILE = ".okf-knowledge.json";
const DEFAULT_PREVIEW_TTL_MS = 15 * 60 * 1000;

class KnowledgeHttpError extends Error {
  constructor(statusCode, message, payload) {
    super(message);
    this.name = "KnowledgeHttpError";
    this.statusCode = statusCode;
    if (payload !== undefined) this.payload = payload;
  }
}

class KnowledgeUsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "KnowledgeUsageError";
    this.exitCode = 2;
  }
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function candidateDigestFor(files) {
  const manifest = files
    .map((file) => ({ path: file.path, sha256: file.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return sha256Hex(JSON.stringify(manifest));
}

function newIdempotencyKey(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(12).toString("hex")}`;
}

function normalizeBaseUrl(url) {
  const value = String(url || "").trim().replace(/\/+$/, "");
  if (!value) {
    throw new KnowledgeUsageError("--url <base-url> is required (for example http://127.0.0.1:8765).");
  }
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("protocol");
    }
    return parsed.toString().replace(/\/+$/, "");
  } catch (_error) {
    throw new KnowledgeUsageError(`--url must be a valid http(s) base URL: ${url}`);
  }
}

async function requestJson(fetchImpl, url, options) {
  const config = options || {};
  const headers = { accept: "application/json" };
  if (config.body !== undefined) {
    headers["content-type"] = "application/json";
  }
  // The token is read from the environment by callers and sent as a header;
  // it must never appear in argv or process titles.
  if (config.token) {
    headers.authorization = `Bearer ${config.token}`;
  }
  if (config.idempotencyKey) {
    headers["idempotency-key"] = config.idempotencyKey;
  }
  let response;
  try {
    response = await fetchImpl(url, {
      method: config.method || "GET",
      headers,
      ...(config.body !== undefined ? { body: JSON.stringify(config.body) } : {}),
    });
  } catch (error) {
    throw new KnowledgeHttpError(0, `Could not reach the OKF server at ${url}: ${error && error.message ? error.message : error}`);
  }
  let payload = null;
  const text = await response.text();
  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch (_error) {
      payload = null;
    }
  }
  if (!response.ok) {
    const serverMessage = payload && payload.error ? payload.error : "";
    const detail = payload && payload.details ? payload.details : undefined;
    const messages = {
      401: "Unauthorized: the server requires a bearer token. Set OKF_ROLLOUT_TOKEN or OKF_READ_TOKEN.",
      403: "Forbidden: the supplied token was rejected by the OKF server.",
      404: `Not found: ${serverMessage || url}`,
      409: `Conflict: ${serverMessage || "the request conflicts with server state."}`,
      422: `Rejected: ${serverMessage || "the candidate failed validation."}`,
    };
    const message = messages[response.status]
      || (response.status >= 500
        ? `OKF server error (${response.status}): ${serverMessage || response.statusText || "internal failure"}`
        : `OKF request failed (${response.status}): ${serverMessage || response.statusText}`);
    throw new KnowledgeHttpError(response.status, message, payload === null ? undefined : {
      ...(detail !== undefined ? { details: detail } : {}),
      ...(payload && !payload.details ? { response: payload } : {}),
    });
  }
  return payload;
}

// ---- Workspace handling -----------------------------------------------------

function safeWorkspacePath(workspaceRoot, relativePath) {
  const absolutePath = path.resolve(workspaceRoot, ...String(relativePath).split("/"));
  const relative = path.relative(workspaceRoot, absolutePath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new KnowledgeUsageError(`Snapshot path escapes the workspace: ${relativePath}`);
  }
  return absolutePath;
}

function listWorkspaceFiles(dir) {
  const files = [];
  const walk = (current, relative) => {
    fs.readdirSync(current, { withFileTypes: true }).forEach((entry) => {
      if (entry.name.startsWith(".")) return;
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const absolutePath = path.join(current, entry.name);
      const stat = fs.lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new KnowledgeUsageError(`Workspace contains a symbolic link; remove it first: ${entryRelative}`);
      }
      if (stat.isDirectory()) {
        walk(absolutePath, entryRelative);
        return;
      }
      if (stat.isFile() && /\.md$/i.test(entry.name)) {
        files.push({ path: entryRelative, absolutePath });
      }
    });
  };
  walk(dir, "");
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files.map((file) => {
    const content = fs.readFileSync(file.absolutePath, "utf8");
    return { path: file.path, content, sha256: sha256Hex(content) };
  });
}

function readWorkspaceState(dir) {
  const statePath = path.join(dir, WORKSPACE_STATE_FILE);
  if (!fs.existsSync(statePath)) {
    throw new KnowledgeUsageError(
      `No knowledge workspace state in ${dir}. Run "okf knowledge download" first.`,
    );
  }
  let state;
  try {
    state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch (_error) {
    throw new KnowledgeUsageError(`Workspace state file is not valid JSON: ${statePath}`);
  }
  if (!state || typeof state.revision !== "string" || typeof state.url !== "string") {
    throw new KnowledgeUsageError(`Workspace state file is incomplete: ${statePath}`);
  }
  return state;
}

function writeStateInto(dir, state) {
  const statePath = path.join(dir, WORKSPACE_STATE_FILE);
  const temporaryPath = `${statePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.renameSync(temporaryPath, statePath);
  } finally {
    if (fs.existsSync(temporaryPath)) {
      fs.unlinkSync(temporaryPath);
    }
  }
}

function writeWorkspaceState(dir, state) {
  writeStateInto(dir, state);
}

function resolveToken(env) {
  const source = env || process.env;
  return String(source.OKF_ROLLOUT_TOKEN || source.OKF_WRITE_TOKEN || source.OKF_READ_TOKEN || "");
}

function diffAgainstState(previousFiles, nextFiles) {
  const before = new Map(previousFiles.map((file) => [file.path, file.sha256]));
  const after = new Map(nextFiles.map((file) => [file.path, file.sha256]));
  const added = [];
  const updated = [];
  const removed = [];
  after.forEach((digest, filePath) => {
    if (!before.has(filePath)) added.push(filePath);
    else if (before.get(filePath) !== digest) updated.push(filePath);
  });
  before.forEach((_digest, filePath) => {
    if (!after.has(filePath)) removed.push(filePath);
  });
  return { added: added.sort(), updated: updated.sort(), removed: removed.sort() };
}

// ---- Commands ---------------------------------------------------------------

async function downloadSnapshot(options) {
  const config = options || {};
  const fetchImpl = config.fetchImpl || fetch;
  const baseUrl = normalizeBaseUrl(config.url);
  const outputDir = path.resolve(config.output || ".");
  const query = config.bundle ? `?bundle=${encodeURIComponent(config.bundle)}` : "";
  const snapshot = await requestJson(fetchImpl, `${baseUrl}/v1/rollout/snapshot${query}`, {
    token: resolveToken(config.env),
  });
  if (!snapshot || !Array.isArray(snapshot.files)) {
    throw new KnowledgeHttpError(0, "Snapshot response did not include a files array.");
  }

  // Stage into a sibling directory on the same filesystem, then swap so the
  // workspace and its state file switch together and stale Markdown from an
  // earlier download never survives.
  const stagingDir = `${outputDir}.staging-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  const backupDir = `${outputDir}.backup-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  let swapped = false;
  try {
    fs.mkdirSync(stagingDir, { recursive: true });
    snapshot.files.forEach((file) => {
      const absolutePath = safeWorkspacePath(stagingDir, file.path);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, file.content, "utf8");
    });
    const state = {
      version: 2,
      url: baseUrl,
      bundle: snapshot.bundle,
      revision: snapshot.revision,
      generationId: snapshot.generationId || null,
      downloadedAt: new Date().toISOString(),
      preview: null,
      pendingDryRun: null,
      pendingSubmit: null,
      files: snapshot.files.map((file) => ({ path: file.path, sha256: file.sha256 })),
    };
    writeStateInto(stagingDir, state);

    if (fs.existsSync(outputDir)) {
      if (!fs.statSync(outputDir).isDirectory()) {
        throw new KnowledgeUsageError(`Download target exists and is not a directory: ${outputDir}`);
      }
      // Refuse to clobber symlinked workspaces.
      const checkSymlinks = (current) => {
        fs.readdirSync(current, { withFileTypes: true }).forEach((entry) => {
          const absolutePath = path.join(current, entry.name);
          if (entry.isSymbolicLink()) {
            throw new KnowledgeUsageError(`Refusing to replace a symbolic link in the workspace: ${absolutePath}`);
          }
          if (entry.isDirectory()) checkSymlinks(absolutePath);
        });
      };
      checkSymlinks(outputDir);
      fs.renameSync(outputDir, backupDir);
      fs.renameSync(stagingDir, outputDir);
      swapped = true;
      fs.rmSync(backupDir, { recursive: true, force: true });
    } else {
      fs.mkdirSync(path.dirname(outputDir), { recursive: true });
      fs.renameSync(stagingDir, outputDir);
      swapped = true;
    }
  } finally {
    if (!swapped && fs.existsSync(stagingDir)) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
    if (!swapped && fs.existsSync(backupDir) && !fs.existsSync(outputDir)) {
      fs.renameSync(backupDir, outputDir);
    }
  }

  return {
    action: "download",
    workspace: outputDir,
    bundle: snapshot.bundle,
    revision: snapshot.revision,
    generationId: snapshot.generationId || null,
    fileCount: snapshot.files.length,
  };
}

async function submitWorkspace(options) {
  const config = options || {};
  const fetchImpl = config.fetchImpl || fetch;
  const dir = path.resolve(config.dir || ".");
  const state = readWorkspaceState(dir);
  const baseUrl = normalizeBaseUrl(config.url || state.url);
  const token = resolveToken(config.env);
  const localFiles = listWorkspaceFiles(dir);
  const candidateDigest = candidateDigestFor(localFiles);
  const changes = diffAgainstState(state.files || [], localFiles);
  const hasChanges = changes.added.length || changes.updated.length || changes.removed.length;

  // Explicit --preview-id: never generate or show a different preview. The
  // override must match the persisted preview state and the current workspace
  // bytes exactly; otherwise it is rejected before any server round-trip.
  if (config.previewId) {
    const persisted = state.preview || null;
    if (!persisted || persisted.previewId !== config.previewId) {
      throw new KnowledgeUsageError(
        `--preview-id ${config.previewId} does not match the persisted preview in this workspace. `
        + "Run knowledge submit --dry-run first.",
      );
    }
    if (persisted.candidateDigest !== candidateDigest) {
      throw new KnowledgeUsageError(
        "The workspace changed since this preview was issued. Run knowledge submit --dry-run again.",
      );
    }
    return submitWithPreview(config, {
      fetchImpl,
      dir,
      state,
      baseUrl,
      token,
      localFiles,
      candidateDigest,
      changes,
      hasChanges,
      previewId: config.previewId,
      expiresAt: persisted.expiresAt,
      diffText: persisted.diffText || "",
      diffTruncated: Boolean(persisted.diffTruncated),
      skipDryRun: true,
    });
  }

  // Stable dry-run idempotency key per candidate digest so a timeout retry
  // replays instead of piling up previews.
  let pendingDryRun = state.pendingDryRun || null;
  if (!pendingDryRun || pendingDryRun.candidateDigest !== candidateDigest) {
    pendingDryRun = { key: newIdempotencyKey("dry"), candidateDigest };
  }
  const dryRunState = Object.assign({}, state, { pendingDryRun });
  writeWorkspaceState(dir, dryRunState);

  const requestBody = {
    bundle: config.bundle || state.bundle,
    baseRevision: state.revision,
    candidateDigest,
    files: localFiles.map((file) => ({ path: file.path, content: file.content })),
    ...(config.message ? { message: String(config.message) } : {}),
  };

  // Always validate remotely first; this also issues the server-side preview.
  const preview = await requestJson(fetchImpl, `${baseUrl}/v1/rollout/dry-run`, {
    method: "POST",
    token,
    idempotencyKey: pendingDryRun.key,
    body: requestBody,
  });

  const savedPreview = {
    previewId: preview.previewId,
    expiresAt: preview.expiresAt,
    baseRevision: state.revision,
    candidateDigest,
    canonicalRequestDigest: preview.canonicalRequestDigest,
    diffText: preview.diffText || "",
    diffTruncated: Boolean(preview.diffTruncated),
    savedAt: new Date().toISOString(),
  };
  const stateWithPreview = Object.assign({}, dryRunState, { preview: savedPreview });
  writeWorkspaceState(dir, stateWithPreview);

  if (config.dryRun) {
    return {
      action: "dry-run",
      workspace: dir,
      bundle: preview.bundle,
      previewId: preview.previewId,
      expiresAt: preview.expiresAt,
      baseRevisionMatches: preview.baseRevisionMatches,
      currentRevision: preview.currentRevision,
      candidateDigest,
      canonicalRequestDigest: preview.canonicalRequestDigest,
      changes,
      hasChanges,
      valid: preview.valid,
      validation: preview.validation,
      diffText: preview.diffText || "",
      diffTruncated: Boolean(preview.diffTruncated),
    };
  }

  return submitWithPreview(config, {
    fetchImpl,
    dir,
    state,
    baseUrl,
    token,
    localFiles,
    candidateDigest,
    changes,
    hasChanges,
    previewId: savedPreview.previewId,
    expiresAt: savedPreview.expiresAt,
    diffText: savedPreview.diffText,
    diffTruncated: savedPreview.diffTruncated,
    skipDryRun: false,
    stateWithPreview,
    requestBody,
    previewResult: preview,
  });
}

async function submitWithPreview(config, context) {
  const {
    fetchImpl, dir, state, baseUrl, token, localFiles, candidateDigest,
    changes, hasChanges, previewId, expiresAt, diffText, diffTruncated, skipDryRun,
  } = context;
  let stateWithPreview = context.stateWithPreview
    || Object.assign({}, state, { preview: state.preview });
  let requestBody = context.requestBody || {
    bundle: config.bundle || state.bundle,
    baseRevision: state.revision,
    candidateDigest,
    files: localFiles.map((file) => ({ path: file.path, content: file.content })),
    ...(config.message ? { message: String(config.message) } : {}),
  };
  const preview = context.previewResult || null;

  if (!skipDryRun && !hasChanges && preview.baseRevisionMatches !== false) {
    writeWorkspaceState(dir, Object.assign({}, stateWithPreview, { pendingSubmit: null }));
    return {
      action: "submit",
      published: false,
      upToDate: true,
      workspace: dir,
      bundle: preview.bundle,
      revision: preview.currentRevision,
      changes,
    };
  }

  if (!config.yes) {
    const stdout = config.stdout || process.stdout;
    // The server-generated diff must be visible before confirmation.
    if (diffText) {
      stdout.write(`--- Proposed diff (preview ${previewId}${diffTruncated ? ", truncated" : ""}) ---\n`);
      stdout.write(diffText);
      stdout.write("--- End of proposed diff ---\n");
    }
    const confirmed = await confirmPreview(
      config.stdin || process.stdin,
      stdout,
      changes,
      {
        bundle: (preview && preview.bundle) || state.bundle,
        previewId,
        expiresAt,
        candidateDigest,
      },
    );
    if (!confirmed) {
      return {
        action: "submit",
        published: false,
        cancelled: true,
        workspace: dir,
        bundle: (preview && preview.bundle) || state.bundle,
        previewId,
        changes,
      };
    }
  }

  // Persist the submit idempotency key before sending so a timeout retry
  // reuses the same key and safely replays.
  let pendingSubmit = state.pendingSubmit || null;
  if (!pendingSubmit || pendingSubmit.candidateDigest !== candidateDigest || pendingSubmit.previewId !== previewId) {
    pendingSubmit = { key: newIdempotencyKey("sub"), candidateDigest, previewId };
  }
  writeWorkspaceState(dir, Object.assign({}, stateWithPreview, { pendingSubmit }));

  const result = await requestJson(fetchImpl, `${baseUrl}/v1/rollout/submit`, {
    method: "POST",
    token,
    idempotencyKey: pendingSubmit.key,
    body: Object.assign({}, requestBody, {
      previewId,
      confirmed: true,
    }),
  });

  writeWorkspaceState(dir, Object.assign({}, state, {
    revision: result.revision,
    generationId: result.generationId || null,
    submittedAt: new Date().toISOString(),
    preview: null,
    pendingDryRun: null,
    pendingSubmit: null,
    files: localFiles.map((file) => ({ path: file.path, sha256: file.sha256 })),
  }));
  return {
    action: "submit",
    published: true,
    workspace: dir,
    bundle: result.bundle,
    generationId: result.generationId || null,
    baseRevision: result.baseRevision,
    revision: result.revision,
    added: result.added,
    updated: result.updated,
    removed: result.removed,
    changes,
  };
}

function confirmPreview(stdin, stdout, changes, preview) {
  return new Promise((resolve) => {
    const changeCount = changes.added.length + changes.updated.length + changes.removed.length;
    stdout.write(
      `Apply ${changeCount} change(s) to bundle "${preview.bundle}"? `
      + `preview ${preview.previewId} digest ${preview.candidateDigest} (expires ${preview.expiresAt}) [y/N] `,
    );
    let buffer = "";
    const cleanup = () => {
      stdin.removeListener("data", onData);
    };
    function onData(chunk) {
      buffer += String(chunk);
      if (!buffer.includes("\n")) return;
      cleanup();
      const answer = buffer.trim().toLowerCase();
      resolve(answer === "y" || answer === "yes");
    }
    stdin.on("data", onData);
    if (!stdin.readable) {
      cleanup();
      resolve(false);
    }
  });
}

async function fetchStatus(options) {
  const config = options || {};
  const fetchImpl = config.fetchImpl || fetch;
  const baseUrl = normalizeBaseUrl(config.url);
  const query = config.bundle ? `?bundle=${encodeURIComponent(config.bundle)}` : "";
  return requestJson(fetchImpl, `${baseUrl}/v1/rollout/status${query}`, {
    token: resolveToken(config.env),
  });
}

module.exports = {
  DEFAULT_PREVIEW_TTL_MS,
  KnowledgeHttpError,
  KnowledgeUsageError,
  WORKSPACE_STATE_FILE,
  candidateDigestFor,
  confirmPreview,
  diffAgainstState,
  downloadSnapshot,
  fetchStatus,
  listWorkspaceFiles,
  newIdempotencyKey,
  normalizeBaseUrl,
  readWorkspaceState,
  requestJson,
  resolveToken,
  submitWorkspace,
};
