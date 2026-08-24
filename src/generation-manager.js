"use strict";

// Immutable generation store for safe knowledge rollout.
//
// Layout (all inside the configured generations root, on the same filesystem
// as the bundles it serves):
//
//   <generationsRoot>/<bundleId>/active.json            atomic pointer
//   <generationsRoot>/<bundleId>/<generationId>/files/  complete candidate
//   <generationsRoot>/<bundleId>/<generationId>/manifest.json
//   <generationsRoot>/previews/<previewId>.json         server-issued previews
//   <generationsRoot>/idempotency/<scope>/<key>.json    replay records
//
// Serving (snapshot download/status and the hosted MCP index) reads ONLY the
// active generation; the materialized bundle root is a compatibility mirror
// maintained by the manager and is never the serving source.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildIndex } = require("./indexer");
const { validateIndex } = require("./validation");
const { normalizeBundleFilePath } = require("./store");

class SnapshotConflictError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "SnapshotConflictError";
    this.statusCode = 409;
    if (details !== undefined) this.details = details;
  }
}

class SnapshotValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "SnapshotValidationError";
    this.statusCode = 422;
    if (details !== undefined) {
      this.details = details;
    }
  }
}

class SnapshotNotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = "SnapshotNotFoundError";
    this.statusCode = 404;
  }
}

function sha256Hex(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function randomId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(8).toString("hex")}`;
}

function writeAtomic(filePath, text, mode) {
  ensureDir(path.dirname(filePath));
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`,
  );
  try {
    fs.writeFileSync(temporaryPath, text, { encoding: "utf8", flag: "wx", ...(mode ? { mode } : {}) });
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fs.existsSync(temporaryPath)) {
      fs.unlinkSync(temporaryPath);
    }
  }
}

function writeJsonAtomic(filePath, value, mode) {
  writeAtomic(filePath, JSON.stringify(value, null, 2) + "\n", mode || 0o600);
}

function readJsonIfExists(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_error) {
    return null;
  }
}

function sanitizeBundleId(id) {
  const clean = String(id || "").trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(clean) || clean.startsWith(".")) {
    throw new SnapshotValidationError(`Unsafe bundle id: ${id || "<missing>"}`);
  }
  return clean;
}

// Strict candidate path rules: relative POSIX Markdown paths, no traversal,
// no hidden or control components, no reserved control directories.
function assertSafeCandidatePath(value) {
  const raw = String(value === undefined || value === null ? "" : value).trim();
  let normalized;
  try {
    normalized = normalizeBundleFilePath(raw);
  } catch (error) {
    throw new SnapshotValidationError(`Unsafe candidate path: ${raw || "<missing>"} (${error.message})`);
  }
  if (!/\.md$/i.test(normalized)) {
    throw new SnapshotValidationError(`Candidate files must be Markdown documents: ${normalized}`);
  }
  const segments = normalized.split("/");
  for (const segment of segments) {
    // eslint-disable-next-line no-control-regex
    if (/[\0-\x1f\x7f]/.test(segment)) {
      throw new SnapshotValidationError(`Candidate path contains control characters: ${normalized}`);
    }
    if (segment.startsWith(".")) {
      throw new SnapshotValidationError(`Hidden path components are rejected: ${normalized}`);
    }
    if (segment === ".git" || segment === "node_modules") {
      throw new SnapshotValidationError(`Reserved directory names are rejected: ${normalized}`);
    }
  }
  return normalized;
}

function normalizeCandidateFiles(input) {
  const rawFiles = input && Array.isArray(input.files) ? input.files : null;
  if (!rawFiles) {
    throw new SnapshotValidationError("Candidate bundle requires a files array.");
  }
  if (rawFiles.length > 5000) {
    throw new SnapshotValidationError("Candidate bundle exceeds 5000 files.");
  }
  const seen = new Set();
  const files = rawFiles.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new SnapshotValidationError("Each candidate file must be an object with path and content.");
    }
    if (typeof entry.content !== "string") {
      throw new SnapshotValidationError(`Candidate file content must be a string: ${entry.path || "<missing>"}`);
    }
    const relativePath = assertSafeCandidatePath(entry.path);
    if (seen.has(relativePath)) {
      throw new SnapshotValidationError(`Duplicate candidate file path: ${relativePath}`);
    }
    seen.add(relativePath);
    return {
      path: relativePath,
      content: entry.content,
      sha256: sha256Hex(entry.content),
      bytes: Buffer.byteLength(entry.content, "utf8"),
    };
  });
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

function candidateDigestFor(files) {
  const manifest = files
    .map((file) => ({ path: file.path, sha256: file.sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path));
  return sha256Hex(JSON.stringify(manifest));
}

function canonicalRequestDigest(payload) {
  return sha256Hex(JSON.stringify(payload));
}

function diffManifest(beforeFiles, afterFiles) {
  const before = new Map(beforeFiles.map((file) => [file.path, file.sha256]));
  const after = new Map(afterFiles.map((file) => [file.path, file.sha256]));
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
  return {
    added: added.sort(),
    updated: updated.sort(),
    removed: removed.sort(),
    unchanged: after.size - added.length - updated.length,
  };
}

class GenerationManager {
  constructor(store, options) {
    this.store = store;
    this.retainGenerations = Math.max(2, (options && options.retainGenerations) || 5);
    // Compatibility mirror is opt-in: serving never depends on the mutable root.
    this.materialize = Boolean(options && options.materialize);
    this.previewTtlMs = (options && options.previewTtlMs) || 15 * 60 * 1000;
    this.onActivated = (options && options.onActivated) || null;
    this.generationsRoot = options && options.generationsRoot
      ? path.resolve(options.generationsRoot)
      : store.project && store.project.rootMode
        ? path.join(
          path.dirname(store.projectRoot),
          `.${path.basename(store.projectRoot)}.okf-generations`,
        )
        : path.join(store.projectRoot || path.dirname(store.proposalRoot), ".okf-generations");
    this.writeQueue = Promise.resolve();
    this.keyedLocks = new Map();
    this.verifiedGenerations = new Map();
  }

  bundleDir(bundleId) {
    return path.join(this.generationsRoot, sanitizeBundleId(bundleId));
  }

  activePointerPath(bundleId) {
    return path.join(this.bundleDir(bundleId), "active.json");
  }

  generationDir(bundleId, generationId) {
    if (!/^[A-Za-z0-9_.-]+$/.test(String(generationId || "")) || String(generationId).startsWith(".")) {
      throw new SnapshotValidationError(`Unsafe generation id: ${generationId}`);
    }
    return path.join(this.bundleDir(bundleId), String(generationId));
  }

  filesDir(bundleId, generationId) {
    return path.join(this.generationDir(bundleId, generationId), "files");
  }

  // Verify one generation completely: manifest shape, safe paths, file
  // existence, per-file digests and byte counts, aggregate revision and
  // candidate digest, and a full index build over the generation bytes.
  verifyGeneration(bundleId, generationId) {
    const bundle = this.resolveBundle(bundleId);
    const manifestPath = path.join(this.generationDir(bundle.id, generationId), "manifest.json");
    const manifest = readJsonIfExists(manifestPath);
    if (!manifest || manifest.bundle !== bundle.id || manifest.generationId !== generationId) {
      throw new SnapshotValidationError(`Generation manifest is missing or mismatched: ${generationId}`);
    }
    if (!Array.isArray(manifest.files) || manifest.fileCount !== manifest.files.length) {
      throw new SnapshotValidationError(`Generation manifest file count mismatch: ${generationId}`);
    }
    const filesDir = this.filesDir(bundle.id, generationId);
    const files = manifest.files.map((entry) => {
      const relativePath = assertSafeCandidatePath(entry.path);
      const absolutePath = path.join(filesDir, ...relativePath.split("/"));
      let stat;
      try {
        stat = fs.lstatSync(absolutePath);
      } catch (_error) {
        throw new SnapshotValidationError(`Generation file is missing: ${relativePath}`);
      }
      if (!stat.isFile()) {
        throw new SnapshotValidationError(`Generation file is not a regular file: ${relativePath}`);
      }
      const content = fs.readFileSync(absolutePath, "utf8");
      const digest = sha256Hex(content);
      if (digest !== entry.sha256) {
        throw new SnapshotValidationError(`Generation file digest mismatch: ${relativePath}`);
      }
      if (entry.bytes !== Buffer.byteLength(content, "utf8")) {
        throw new SnapshotValidationError(`Generation file byte count mismatch: ${relativePath}`);
      }
      return { path: relativePath, content, sha256: digest, bytes: Buffer.byteLength(content, "utf8") };
    });
    const recomputedRevision = `sha256:${sha256Hex(JSON.stringify(files.map((file) => ({ path: file.path, sha256: file.sha256 })).sort((left, right) => left.path.localeCompare(right.path))))}`;
    if (recomputedRevision !== manifest.revision) {
      throw new SnapshotValidationError(`Generation revision mismatch: ${generationId}`);
    }
    if (candidateDigestFor(files) !== manifest.candidateDigest) {
      throw new SnapshotValidationError(`Generation candidate digest mismatch: ${generationId}`);
    }
    // Full index build over the verified bytes.
    const index = buildIndex([{
      id: bundle.id,
      root: filesDir,
      include: bundle.include || [],
      exclude: bundle.exclude || [],
    }], {
      relationTypes: this.store.getRelationTypes(),
      strictLinks: this.store.strictLinks,
      allowCustomRelationTypes: this.store.allowCustomRelationTypes,
    });
    return { manifest, files, index };
  }

  listRetainedManifests(bundleId) {
    try {
      return fs.readdirSync(this.bundleDir(bundleId), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => readJsonIfExists(path.join(this.bundleDir(bundleId), entry.name, "manifest.json")))
        .filter((manifest) => manifest && manifest.bundle === bundleId && manifest.generationId)
        .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
    } catch (_error) {
      return [];
    }
  }

  acceptGeneration(bundleId, generationId, verified) {
    this.verifiedGenerations.set(`${bundleId}:${generationId}`, verified);
  }

  isVerifiedGeneration(bundleId, generationId) {
    return this.verifiedGenerations.has(`${bundleId}:${generationId}`);
  }

  // Seed every writable bundle. Startup integrity rules:
  // - a fresh store (no generations at all) seeds from the configured root;
  // - a corrupt active pointer falls back to the newest VERIFIED retained
  //   generation;
  // - if generations exist but none verifies, startup is refused.
  seedAll() {
    for (const bundle of this.store.getBundles().filter((entry) => !entry.remote)) {
      this.seedBundle(bundle.id);
    }
    // Final gate: the complete accepted active project must build a valid index.
    const bundleArgs = this.store.getBundles()
      .filter((entry) => !entry.remote)
      .map((entry) => ({
        id: entry.id,
        root: this.filesDir(entry.id, this.getActive(entry.id).generationId),
        include: entry.include || [],
        exclude: entry.exclude || [],
      }));
    const index = buildIndex(bundleArgs, {
      relationTypes: this.store.getRelationTypes(),
      strictLinks: this.store.strictLinks,
      allowCustomRelationTypes: this.store.allowCustomRelationTypes,
    });
    const validation = validateIndex(index);
    if (!validation.valid) {
      throw new Error(
        "Refusing hosted startup: the recovered active generations do not form a valid OKF project.",
      );
    }
    return { validation };
  }

  seedBundle(bundleId) {
    const bundle = this.resolveBundle(bundleId);
    const candidates = [];
    const pointer = readJsonIfExists(this.activePointerPath(bundle.id));
    if (pointer && pointer.generationId) {
      candidates.push(pointer.generationId);
    }
    for (const manifest of this.listRetainedManifests(bundle.id)) {
      if (!candidates.includes(manifest.generationId)) {
        candidates.push(manifest.generationId);
      }
    }
    const hasGenerations = candidates.length > 0;
    for (const generationId of candidates) {
      try {
        const verified = this.verifyGeneration(bundle.id, generationId);
        this.acceptGeneration(bundle.id, generationId, verified);
        if (!pointer || pointer.generationId !== generationId || !pointer.revision
          || pointer.revision !== verified.manifest.revision) {
          writeJsonAtomic(this.activePointerPath(bundle.id), {
            bundle: bundle.id,
            generationId,
            revision: verified.manifest.revision,
            previousGenerationId: null,
            activatedAt: new Date().toISOString(),
            recovered: true,
          }, 0o644);
        }
        return this.getActive(bundle.id);
      } catch (_error) {
        // Try the next retained generation.
      }
    }
    if (hasGenerations) {
      throw new Error(
        `Refusing startup for bundle "${bundle.id}": no retained generation passed integrity verification.`,
      );
    }
    // Fresh install: seed a first generation from the current root bytes.
    const files = this.readRootFiles(bundle);
    return this.activateGeneration(bundle, files, {
      message: "seeded-from-root",
      baseRevision: null,
      materialize: false,
    });
  }

  // Backwards-compatible single-bundle seeding used by tests.
  seed(bundleId) {
    return this.seedBundle(bundleId);
  }

  resolveBundle(bundleId) {
    const bundles = this.store.getBundles().filter((entry) => !entry.remote);
    const bundle = bundleId
      ? bundles.find((entry) => entry.id === bundleId)
      : bundles.length === 1 ? bundles[0] : null;
    if (!bundle) {
      throw new SnapshotNotFoundError(bundleId
        ? `Unknown writable OKF bundle: ${bundleId}`
        : "A bundle id is required unless exactly one writable OKF root is configured.");
    }
    return bundle;
  }

  readRootFiles(bundle) {
    const realRoot = this.store.resolveWritableBundleRoot(bundle);
    const files = [];
    const walk = (current, relative) => {
      let entries;
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch (_error) {
        return;
      }
      entries.forEach((entry) => {
        if (entry.name.startsWith(".")) return;
        const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
        const absolutePath = path.join(current, entry.name);
        let stat;
        try {
          stat = fs.lstatSync(absolutePath);
        } catch (_error) {
          return;
        }
        if (stat.isSymbolicLink()) return;
        if (stat.isDirectory()) {
          walk(absolutePath, entryRelative);
          return;
        }
        if (stat.isFile() && /\.md$/i.test(entry.name)) {
          const content = fs.readFileSync(absolutePath, "utf8");
          files.push({ path: entryRelative, content, sha256: sha256Hex(content), bytes: Buffer.byteLength(content, "utf8") });
        }
      });
    };
    walk(realRoot, "");
    files.sort((left, right) => left.path.localeCompare(right.path));
    return files;
  }

  getActive(bundleId) {
    const bundle = this.resolveBundle(bundleId);
    const pointer = readJsonIfExists(this.activePointerPath(bundle.id));
    if (!pointer || !pointer.generationId) {
      throw new SnapshotNotFoundError(`No active generation for bundle: ${bundle.id}`);
    }
    const manifest = readJsonIfExists(path.join(this.generationDir(bundle.id, pointer.generationId), "manifest.json"));
    if (!manifest) {
      throw new SnapshotNotFoundError(`Active generation manifest is missing for bundle: ${bundle.id}`);
    }
    return {
      bundle: bundle.id,
      generationId: pointer.generationId,
      revision: manifest.revision,
      manifest,
      activatedAt: pointer.activatedAt,
    };
  }

  readActiveFiles(bundleId) {
    const active = this.getActive(bundleId);
    const filesDir = this.filesDir(active.bundle, active.generationId);
    const files = (active.manifest.files || []).map((entry) => {
      const absolutePath = path.join(filesDir, ...entry.path.split("/"));
      const content = fs.readFileSync(absolutePath, "utf8");
      const actualDigest = sha256Hex(content);
      if (actualDigest !== entry.sha256) {
        throw new SnapshotValidationError(
          `Active generation file failed digest verification: ${entry.path}`,
          { expected: entry.sha256, actual: actualDigest },
        );
      }
      return { path: entry.path, content, sha256: entry.sha256, bytes: Buffer.byteLength(content, "utf8") };
    });
    return { active, files };
  }

  // Stage a complete candidate into the generation store and validate its
  // index BEFORE anything is activated. Returns the staged descriptor.
  stageCandidate(bundle, files) {
    const generationId = randomId("gen");
    const generationPath = this.generationDir(bundle.id, generationId);
    const filesDir = path.join(generationPath, "files");
    ensureDir(filesDir);
    try {
      files.forEach((file) => {
        const absolutePath = path.join(filesDir, ...file.path.split("/"));
        ensureDir(path.dirname(absolutePath));
        fs.writeFileSync(absolutePath, file.content, { encoding: "utf8" });
      });
      const bundleArgs = this.store.getBundles().map((entry) => ({
        id: entry.id,
        root: entry.id === bundle.id
          ? filesDir
          : this.filesDir(entry.id, this.getActive(entry.id).generationId),
        include: entry.include || [],
        exclude: entry.exclude || [],
      }));
      const index = buildIndex(bundleArgs, {
        relationTypes: this.store.getRelationTypes(),
        strictLinks: this.store.strictLinks,
        allowCustomRelationTypes: this.store.allowCustomRelationTypes,
      });
      const validation = validateIndex(index);
      return { generationId, generationPath, filesDir, bundleArgs, index, validation };
    } catch (error) {
      fs.rmSync(generationPath, { recursive: true, force: true });
      throw error;
    }
  }

  discardStaged(bundleId, staged) {
    if (staged && staged.generationPath) {
      fs.rmSync(staged.generationPath, { recursive: true, force: true });
    }
  }

  // Atomically activate a staged generation: manifest first, then the
  // active.json pointer swap. Prior generations are retained for rollback.
  activateGeneration(bundle, files, options) {
    const config = options || {};
    const generationId = config.generationId || randomId("gen");
    const generationPath = this.generationDir(bundle.id, generationId);
    const filesDir = path.join(generationPath, "files");
    ensureDir(filesDir);
    files.forEach((file) => {
      const absolutePath = path.join(filesDir, ...file.path.split("/"));
      ensureDir(path.dirname(absolutePath));
      fs.writeFileSync(absolutePath, file.content, { encoding: "utf8" });
    });
    const manifest = {
      bundle: bundle.id,
      generationId,
      revision: `sha256:${sha256Hex(JSON.stringify(files.map((file) => ({ path: file.path, sha256: file.sha256 })).sort((left, right) => left.path.localeCompare(right.path))))}`,
      candidateDigest: candidateDigestFor(files),
      baseRevision: config.baseRevision || null,
      message: config.message || "",
      fileCount: files.length,
      files: files.map((file) => ({ path: file.path, sha256: file.sha256, bytes: file.bytes })),
      createdAt: new Date().toISOString(),
    };
    writeJsonAtomic(path.join(generationPath, "manifest.json"), manifest);
    const previous = readJsonIfExists(this.activePointerPath(bundle.id));
    writeJsonAtomic(this.activePointerPath(bundle.id), {
      bundle: bundle.id,
      generationId,
      revision: manifest.revision,
      previousGenerationId: previous ? previous.generationId : null,
      activatedAt: manifest.createdAt,
    }, 0o644);
    this.acceptGeneration(bundle.id, generationId, { manifest, files });
    this.pruneGenerations(bundle.id);
    let materialization = { applied: false, reason: this.materialize ? "not_attempted" : "disabled" };
    if (this.materialize && config.materialize !== false) {
      materialization = this.materializeToRoot(bundle, files);
    }
    return {
      bundle: bundle.id,
      generationId,
      revision: manifest.revision,
      manifest,
      materialization,
    };
  }

  // Compatibility mirror: opt-in best-effort sync of the active generation
  // into the configured bundle root. Never the serving source; failures are
  // reported. Every target path is revalidated through the store's safety
  // APIs (traversal + symlink parent chains) immediately before each write.
  materializeToRoot(bundle, files) {
    try {
      const realRoot = this.store.resolveWritableBundleRoot(bundle);
      const desired = new Set(files.map((file) => file.path));
      const removeStale = (current, relative) => {
        fs.readdirSync(current, { withFileTypes: true }).forEach((entry) => {
          if (entry.name.startsWith(".")) return;
          const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
          const absolutePath = path.join(current, entry.name);
          const stat = fs.lstatSync(absolutePath);
          if (stat.isSymbolicLink()) return;
          if (stat.isDirectory()) {
            removeStale(absolutePath, entryRelative);
            return;
          }
          if (/\.md$/i.test(entry.name) && !desired.has(entryRelative)) {
            // Revalidate through store safety checks before unlinking.
            this.store.resolveBundleFile(bundle.id, entryRelative);
            fs.unlinkSync(absolutePath);
          }
        });
      };
      removeStale(realRoot, "");
      files.forEach((file) => {
        // Validates traversal, symlink parents, and in-bounds resolution.
        const safeTarget = this.store.resolveBundleFile(bundle.id, file.path);
        let stat = null;
        try {
          stat = fs.lstatSync(safeTarget.absolutePath);
        } catch (_error) {
          stat = null;
        }
        if (stat && stat.isSymbolicLink()) {
          throw new SnapshotValidationError(`Refusing to replace a symbolic link: ${file.path}`);
        }
        ensureDir(path.dirname(safeTarget.absolutePath));
        writeAtomic(safeTarget.absolutePath, file.content);
      });
      return { applied: true, root: realRoot };
    } catch (error) {
      return {
        applied: false,
        reason: error && error.message ? error.message : String(error),
      };
    }
  }

  pruneGenerations(bundleId) {
    const dir = this.bundleDir(bundleId);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_error) {
      return;
    }
    const pointer = readJsonIfExists(this.activePointerPath(bundleId));
    const generations = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
    while (generations.length > this.retainGenerations) {
      const victim = generations.shift();
      if (pointer && pointer.generationId === victim) continue;
      fs.rmSync(path.join(dir, victim), { recursive: true, force: true });
    }
  }

  async withWriterLock(operation) {
    const current = this.writeQueue.then(operation, operation);
    this.writeQueue = current.catch(() => {});
    return current;
  }

  // Keyed coordination: concurrent operations with the same scope+key are
  // serialized so exactly one executes and the other replays its persisted
  // result instead of racing into a conflict.
  withKeyedLock(scope, key, operation) {
    const lockKey = `${scope}:${key}`;
    const previous = this.keyedLocks.get(lockKey) || Promise.resolve();
    const run = previous.then(operation, operation);
    const tail = run.catch(() => {});
    this.keyedLocks.set(lockKey, tail);
    void tail.then(() => {
      if (this.keyedLocks.get(lockKey) === tail) {
        this.keyedLocks.delete(lockKey);
      }
    });
    return run;
  }

  // ---- Previews -----------------------------------------------------------

  previewPath(previewId) {
    if (!/^pv_[a-f0-9]{32}$/.test(String(previewId || ""))) {
      throw new SnapshotValidationError(`Unsafe preview id: ${previewId || "<missing>"}`);
    }
    return path.join(this.generationsRoot, "previews", `${previewId}.json`);
  }

  savePreview(record) {
    writeJsonAtomic(this.previewPath(record.previewId), record, 0o600);
  }

  loadPreview(previewId) {
    return readJsonIfExists(this.previewPath(previewId));
  }

  issuePreviewTtl() {
    return this.previewTtlMs;
  }

  // ---- Idempotency / publication journal ----------------------------------
  //
  // Records are also the recoverable publication journal for submits:
  //   in_progress -> executing (dry-run) or committing (submit)
  //   done        -> terminal, replayable result
  // A submit found in "committing" on retry is recovered deterministically:
  // if the active generation matches the journaled revision the publication
  // committed and the result is reconstructed; otherwise it aborted and the
  // caller may re-execute.

  idempotencyPath(scope, key) {
    if (!/^[A-Za-z0-9_.:-]{8,128}$/.test(String(key || ""))) {
      throw new SnapshotValidationError(
        "Idempotency-Key must be 8..128 characters from [A-Za-z0-9_.:-].",
      );
    }
    if (!["dry-run", "submit"].includes(scope)) {
      throw new SnapshotValidationError(`Unknown idempotency scope: ${scope}`);
    }
    return path.join(this.generationsRoot, "idempotency", scope, `${key}.json`);
  }

  readIdempotency(scope, key) {
    return readJsonIfExists(this.idempotencyPath(scope, key));
  }

  // Reserve a key for one exact request. Returns:
  //   { state: "reserved" }        fresh reservation created
  //   { state: "existing", record } same key+request already known
  //   { state: "conflict", record } same key reused for a different request
  beginIdempotency(scope, key, principal, requestDigest, extra) {
    const existing = this.readIdempotency(scope, key);
    if (existing) {
      if (existing.principal !== principal || existing.requestDigest !== requestDigest) {
        return { state: "conflict", record: existing };
      }
      return { state: "existing", record: existing };
    }
    const record = Object.assign({
      scope,
      key,
      principal,
      requestDigest,
      status: "in_progress",
      createdAt: new Date().toISOString(),
    }, extra || {});
    writeJsonAtomic(this.idempotencyPath(scope, key), record, 0o600);
    return { state: "reserved" };
  }

  patchIdempotency(scope, key, patch) {
    const record = this.readIdempotency(scope, key);
    if (!record) {
      throw new SnapshotValidationError(`Idempotency record disappeared: ${key}`);
    }
    writeJsonAtomic(this.idempotencyPath(scope, key), Object.assign(record, patch), 0o600);
  }

  finishIdempotency(scope, key, result) {
    const record = this.readIdempotency(scope, key);
    if (!record) {
      throw new SnapshotValidationError(`Idempotency record disappeared: ${key}`);
    }
    writeJsonAtomic(this.idempotencyPath(scope, key), Object.assign(record, {
      status: "done",
      result,
      completedAt: new Date().toISOString(),
    }), 0o600);
  }

  // Legacy whole-record save retained for simple dry-run flows.
  saveIdempotency(scope, key, principal, requestDigest, result) {
    writeJsonAtomic(this.idempotencyPath(scope, key), {
      scope,
      key,
      principal,
      requestDigest,
      status: "done",
      result,
      savedAt: new Date().toISOString(),
    }, 0o600);
  }
}

module.exports = {
  GenerationManager,
  SnapshotConflictError,
  SnapshotNotFoundError,
  SnapshotValidationError,
  assertSafeCandidatePath,
  candidateDigestFor,
  canonicalRequestDigest,
  diffManifest,
  normalizeCandidateFiles,
  realpathSafe: (candidate) => {
    // Local reimplementation to avoid a circular import with store.js helpers.
    const fsSync = fs;
    let current = path.resolve(candidate);
    const suffix = [];
    for (;;) {
      try {
        return path.join(fsSync.realpathSync(current), ...suffix);
      } catch (error) {
        if (error && error.code !== "ENOENT") {
          throw error;
        }
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return path.join(current, ...suffix);
      }
      suffix.unshift(path.basename(current));
      current = parent;
    }
  },
  stageDirectory: () => fs.mkdtempSync(path.join(os.tmpdir(), "okf-stage-")),
};
