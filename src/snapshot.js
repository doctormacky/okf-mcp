"use strict";

// Rollout service on top of the immutable GenerationManager.
//
// Persistence boundary: snapshot download/status and validation read ONLY the
// active published generation stored under the manager's generations root.
// The configured bundle root is a best-effort compatibility mirror that is
// refreshed after activation; it is never the serving source. API responses
// report these boundaries via the `persistence` field.

const {
  GenerationManager,
  SnapshotConflictError,
  SnapshotNotFoundError,
  SnapshotValidationError,
  candidateDigestFor,
  canonicalRequestDigest,
  diffManifest,
  normalizeCandidateFiles,
} = require("./generation-manager");

const DEFAULT_PREVIEW_TTL_MS = 15 * 60 * 1000;
const DEFAULT_DIFF_PER_FILE_LIMIT_BYTES = 8 * 1024;
const DEFAULT_DIFF_TOTAL_LIMIT_BYTES = 64 * 1024;

function byteLength(text) {
  return Buffer.byteLength(text, "utf8");
}

// Truncate a string to at most maxBytes UTF-8 bytes without splitting a
// code point.
function truncateToBytes(text, maxBytes) {
  if (byteLength(text) <= maxBytes) {
    return text;
  }
  let end = text.length;
  while (end > 0 && byteLength(text.slice(0, end)) > maxBytes) {
    end -= 1;
  }
  return text.slice(0, end);
}

// Unified-style line diff for one file: trims the common prefix/suffix and
// renders the changed middle as -old/+new lines.
function buildLineDiff(oldText, newText) {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start += 1;
  }
  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (endOld > start && endNew > start && oldLines[endOld - 1] === newLines[endNew - 1]) {
    endOld -= 1;
    endNew -= 1;
  }
  const lines = [];
  oldLines.slice(start, endOld).forEach((line) => lines.push(`-${line}`));
  newLines.slice(start, endNew).forEach((line) => lines.push(`+${line}`));
  return lines;
}

// Bounded server-generated diff between the active generation and the
// candidate. Only content from those two sets is ever rendered. Per-file and
// total byte limits are enforced with explicit truncation markers.
function buildDiff(activeFiles, candidateFiles, options) {
  const config = options || {};
  const perFileLimit = Math.max(256, config.perFileLimitBytes || DEFAULT_DIFF_PER_FILE_LIMIT_BYTES);
  const totalLimit = Math.max(1024, config.totalLimitBytes || DEFAULT_DIFF_TOTAL_LIMIT_BYTES);
  const activeMap = new Map(activeFiles.map((file) => [file.path, file.content]));
  const candidateMap = new Map(candidateFiles.map((file) => [file.path, file.content]));
  const paths = Array.from(new Set([...activeMap.keys(), ...candidateMap.keys()])).sort();

  const sections = [];
  let totalBytes = 0;
  let truncated = false;
  let omittedFiles = 0;

  for (const filePath of paths) {
    const inActive = activeMap.has(filePath);
    const inCandidate = candidateMap.has(filePath);
    let header;
    let bodyLines;
    if (!inCandidate) {
      header = `Removed: ${filePath}`;
      bodyLines = activeMap.get(filePath).split("\n").map((line) => `-${line}`);
    } else if (!inActive) {
      header = `Added: ${filePath}`;
      bodyLines = candidateMap.get(filePath).split("\n").map((line) => `+${line}`);
    } else {
      const before = activeMap.get(filePath);
      const after = candidateMap.get(filePath);
      if (before === after) {
        continue;
      }
      header = `Updated: ${filePath}`;
      bodyLines = buildLineDiff(before, after);
    }
    let section = `--- ${header} ---\n${bodyLines.join("\n")}\n`;
    if (byteLength(section) > perFileLimit) {
      truncated = true;
      section = `${truncateToBytes(section, perFileLimit)}\n[... diff truncated for ${filePath} ...]\n`;
    }
    if (totalBytes + byteLength(section) > totalLimit) {
      truncated = true;
      omittedFiles += 1;
      continue;
    }
    sections.push(section);
    totalBytes += byteLength(section);
  }

  let diffText = sections.join("");
  if (omittedFiles > 0) {
    diffText += `[... diff truncated: ${omittedFiles} more changed file(s) omitted ...]\n`;
  }
  if (!diffText) {
    diffText = "No content differences.\n";
  }
  return { diffText, truncated };
}

function principalFromToken(token, env) {
  const crypto = require("crypto");
  const configured = env && env.OKF_ROLLOUT_PRINCIPAL;
  if (configured && /^[A-Za-z0-9_.:@-]{3,128}$/.test(String(configured))) {
    return String(configured);
  }
  return `tok-${crypto.createHash("sha256").update(String(token || "")).digest("hex").slice(0, 16)}`;
}

class SnapshotRolloutService {
  constructor(store, options) {
    const config = options || {};
    this.manager = config.manager instanceof GenerationManager
      ? config.manager
      : new GenerationManager(store, config);
    this.store = store;
    this.previewTtlMs = this.manager.previewTtlMs || DEFAULT_PREVIEW_TTL_MS;
    this.diffPerFileLimitBytes = config.diffPerFileLimitBytes || DEFAULT_DIFF_PER_FILE_LIMIT_BYTES;
    this.diffTotalLimitBytes = config.diffTotalLimitBytes || DEFAULT_DIFF_TOTAL_LIMIT_BYTES;
    this.onPublished = config.onPublished || null;
    // Fault injection points for tests: functions may throw to simulate a
    // crash at an exact commit-boundary step.
    this.hooks = config.hooks || {};
  }

  resolveBundle(bundleId) {
    return this.manager.resolveBundle(bundleId);
  }

  persistenceBoundary(bundleId) {
    const bundle = this.resolveBundle(bundleId);
    return {
      servingSource: "active-generation",
      generationStore: this.manager.bundleDir(bundle.id),
      materializedRoot: this.manager.materialize ? bundle.root : null,
      materialization: "best-effort-compatibility-mirror",
    };
  }

  // Download/status read the ACTIVE published generation, never the root.
  currentSnapshot(bundleId) {
    const { active, files } = this.manager.readActiveFiles(bundleId);
    return {
      bundle: active.bundle,
      revision: active.revision,
      generationId: active.generationId,
      generatedAt: active.manifest.createdAt,
      fileCount: files.length,
      files,
      persistence: this.persistenceBoundary(active.bundle),
    };
  }

  status(bundleId) {
    const snapshot = this.currentSnapshot(bundleId);
    return {
      bundle: snapshot.bundle,
      revision: snapshot.revision,
      generationId: snapshot.generationId,
      fileCount: snapshot.fileCount,
      generatedAt: snapshot.generatedAt,
      persistence: snapshot.persistence,
    };
  }

  validateRequest(input) {
    const body = input || {};
    if (typeof body.baseRevision !== "string" || !body.baseRevision.startsWith("sha256:")) {
      throw new SnapshotValidationError("baseRevision is required and must be a sha256 revision string.");
    }
    if (typeof body.candidateDigest !== "string" || !/^[a-f0-9]{64}$/.test(body.candidateDigest)) {
      throw new SnapshotValidationError("candidateDigest is required and must be a lowercase sha256 hex digest.");
    }
    if (!body.bundle && this.store.getBundles().filter((entry) => !entry.remote).length !== 1) {
      throw new SnapshotValidationError("bundle is required unless exactly one writable OKF root is configured.");
    }
    return body;
  }

  computeCanonicalRequestDigest(bundleId, baseRevision, files) {
    return canonicalRequestDigest({
      scope: "full-snapshot",
      bundle: bundleId,
      baseRevision,
      candidateDigest: candidateDigestFor(files),
      fileCount: files.length,
      files: files.map((file) => ({ path: file.path, sha256: file.sha256 })),
    });
  }

  dryRun(input, principal, idempotencyKey) {
    const body = this.validateRequest(input);
    const bundle = this.resolveBundle(body.bundle);
    const files = normalizeCandidateFiles(body);
    const actualDigest = candidateDigestFor(files);
    if (actualDigest !== body.candidateDigest) {
      throw new SnapshotValidationError(
        "candidateDigest does not match the submitted candidate files.",
        { expected: body.candidateDigest, actual: actualDigest },
      );
    }
    const requestDigest = this.computeCanonicalRequestDigest(bundle.id, body.baseRevision, files);
    if (!idempotencyKey) {
      throw new SnapshotValidationError(
        "Idempotency-Key header is required for dry-run so retries return the same preview.",
        { code: "idempotency_key_required" },
      );
    }
    // The dry-run idempotency identity deliberately excludes any submit-time
    // message so a messageless preview can be submitted with one later.
    const idempotencyDigest = canonicalRequestDigest({
      operation: "dry-run",
      canonicalRequestDigest: requestDigest,
    });

    return this.manager.withKeyedLock("dry-run", idempotencyKey, () => {
      const reservation = this.manager.beginIdempotency("dry-run", idempotencyKey, principal, idempotencyDigest);
      if (reservation.state === "conflict") {
        throw new SnapshotConflictError(
          "Idempotency-Key was already used with a different dry-run request.",
          { key: idempotencyKey },
        );
      }
      if (reservation.state === "existing" && reservation.record.status === "done") {
        return Object.assign({}, reservation.record.result, { replayed: true });
      }

      const { active, files: activeFiles } = this.manager.readActiveFiles(bundle.id);
      const staged = this.manager.stageCandidate(bundle, files);
      let validation;
      try {
        validation = staged.validation;
      } finally {
        this.manager.discardStaged(bundle.id, staged);
      }
      const now = Date.now();
      const previewId = `pv_${require("crypto").randomBytes(16).toString("hex")}`;
      const diff = buildDiff(activeFiles, files, {
        perFileLimitBytes: this.diffPerFileLimitBytes,
        totalLimitBytes: this.diffTotalLimitBytes,
      });
      const result = {
        valid: Boolean(validation.valid),
        mode: "dry-run",
        bundle: bundle.id,
        previewId,
        expiresAt: new Date(now + this.previewTtlMs).toISOString(),
        baseRevisionMatches: active.revision === body.baseRevision,
        currentRevision: active.revision,
        submittedBaseRevision: body.baseRevision,
        candidateDigest: actualDigest,
        canonicalRequestDigest: requestDigest,
        fileCount: files.length,
        changes: diffManifest(activeFiles, files),
        validation,
        // Server-generated bounded diff for explicit human confirmation.
        diffText: diff.diffText,
        diffTruncated: diff.truncated,
      };
      this.manager.savePreview({
        previewId,
        principal,
        bundle: bundle.id,
        baseRevision: body.baseRevision,
        candidateDigest: actualDigest,
        canonicalRequestDigest: requestDigest,
        fileCount: files.length,
        files: files.map((file) => ({ path: file.path, content: file.content })),
        createdAt: new Date(now).toISOString(),
        expiresAt: result.expiresAt,
        result,
      });
      this.manager.finishIdempotency("dry-run", idempotencyKey, result);
      return result;
    });
  }

  recoverCommittingSubmit(record) {
    // Deterministic retry semantics after a lost response or restart: if the
    // active generation matches the journaled commit, the publication is
    // committed and its result is reconstructed; otherwise the publication
    // never activated and the journal is released for a fresh attempt.
    let active;
    try {
      active = this.manager.readActiveFiles(record.bundle).active;
    } catch (_error) {
      active = null;
    }
    if (active
      && active.generationId === record.generationId
      && active.revision === record.expectedRevision) {
      const manifest = active.manifest;
      const result = {
        published: true,
        mode: "submit",
        bundle: record.bundle,
        generationId: record.generationId,
        baseRevision: record.baseRevision,
        revision: record.expectedRevision,
        fileCount: record.fileCount,
        added: (record.changes || {}).added || [],
        updated: (record.changes || {}).updated || [],
        removed: (record.changes || {}).removed || [],
        publishedAt: manifest.createdAt,
        message: record.message || "",
        persistence: this.persistenceBoundary(record.bundle),
        materialization: { applied: false, reason: "unknown-after-recovery" },
        recovered: true,
      };
      this.manager.finishIdempotency("submit", record.key, result);
      return Object.assign({}, result, { replayed: true });
    }
    // The pointer never switched (or moved elsewhere): release the journal.
    fsUnlinkIfExists(this.manager.idempotencyPath("submit", record.key));
    return null;
  }

  submit(input, principal, idempotencyKey) {
    const body = this.validateRequest(input);
    if (!body.previewId) {
      throw new SnapshotValidationError(
        "previewId is required: call dry-run first and submit its server-issued preview.",
        { code: "preview_required" },
      );
    }
    if (body.confirmed !== true) {
      throw new SnapshotValidationError(
        "confirmed must be true to publish a previewed candidate.",
        { code: "confirmation_required" },
      );
    }
    if (!idempotencyKey) {
      throw new SnapshotValidationError(
        "Idempotency-Key header is required for submit so retries are safe.",
        { code: "idempotency_key_required" },
      );
    }
    const bundle = this.resolveBundle(body.bundle);
    const files = normalizeCandidateFiles(body);
    const actualDigest = candidateDigestFor(files);
    if (actualDigest !== body.candidateDigest) {
      throw new SnapshotValidationError(
        "candidateDigest does not match the submitted candidate files.",
        { expected: body.candidateDigest, actual: actualDigest },
      );
    }
    const requestDigest = this.computeCanonicalRequestDigest(bundle.id, body.baseRevision, files);
    const idempotencyDigest = canonicalRequestDigest({
      operation: "submit",
      canonicalRequestDigest: requestDigest,
      previewId: body.previewId,
      confirmed: body.confirmed === true,
      message: typeof body.message === "string" ? body.message : "",
    });

    return this.manager.withKeyedLock("submit", idempotencyKey, () => {
      const existing = this.manager.readIdempotency("submit", idempotencyKey);
      if (existing) {
        if (existing.principal !== principal || existing.requestDigest !== idempotencyDigest) {
          throw new SnapshotConflictError(
            "Idempotency-Key was already used with a different submit request.",
            { key: idempotencyKey },
          );
        }
        if (existing.status === "done") {
          return Object.assign({}, existing.result, { replayed: true });
        }
        if (existing.status === "committing") {
          const recovered = this.recoverCommittingSubmit(existing);
          if (recovered) {
            return recovered;
          }
          // Journal released: fall through to a fresh, fully validated attempt.
        }
        // status in_progress/reserved from an aborted pre-pointer attempt.
      }

      const preview = this.manager.loadPreview(body.previewId);
      if (!preview) {
        throw new SnapshotValidationError(
          `Unknown preview: ${body.previewId}. Run dry-run to obtain a fresh preview.`,
          { code: "preview_unknown" },
        );
      }
      if (preview.principal !== principal) {
        const error = new SnapshotValidationError(
          "Preview belongs to a different authenticated principal.",
          { code: "preview_principal_mismatch" },
        );
        error.statusCode = 403;
        throw error;
      }
      if (new Date(preview.expiresAt).getTime() <= Date.now()) {
        throw new SnapshotValidationError(
          "Preview has expired. Run dry-run again to obtain a fresh preview.",
          { code: "preview_expired", expiresAt: preview.expiresAt },
        );
      }
      if (preview.bundle !== bundle.id
        || preview.baseRevision !== body.baseRevision
        || preview.candidateDigest !== actualDigest
        || preview.canonicalRequestDigest !== requestDigest
        || preview.fileCount !== files.length) {
        throw new SnapshotValidationError(
          "Submitted request does not match the bound preview (bundle, base revision, digest, or files changed).",
          { code: "preview_binding_mismatch" },
        );
      }
      if (JSON.stringify(preview.files.map((file) => ({ path: file.path, content: file.content })))
        !== JSON.stringify(files.map((file) => ({ path: file.path, content: file.content })))) {
        throw new SnapshotValidationError(
          "Submitted file contents do not match the bound preview.",
          { code: "preview_content_mismatch" },
        );
      }

      return this.manager.withWriterLock(() => {
        // Re-check under the writer lock: another key may have published first.
        const raced = this.manager.readIdempotency("submit", idempotencyKey);
        if (raced && raced.status === "done" && raced.requestDigest === idempotencyDigest) {
          return Object.assign({}, raced.result, { replayed: true });
        }
        const { active } = this.manager.readActiveFiles(bundle.id);
        if (active.revision !== body.baseRevision) {
          throw new SnapshotConflictError(
            "Base revision does not match the active published generation. Download a fresh snapshot and retry.",
            {
              expected: body.baseRevision,
              actual: active.revision,
              hint: "Re-run knowledge download, reapply changes, and submit again.",
            },
          );
        }

        // Stage and validate the complete candidate (full project index built
        // here, before anything is activated or swapped into MCP state).
        const staged = this.manager.stageCandidate(bundle, files);
        if (!staged.validation.valid) {
          this.manager.discardStaged(bundle.id, staged);
          throw new SnapshotValidationError("Candidate bundle failed OKF validation.", {
            validation: staged.validation,
          });
        }

        // Persist the recoverable commit journal BEFORE the pointer switch so
        // a crash at any later boundary has deterministic retry semantics.
        this.manager.beginIdempotency("submit", idempotencyKey, principal, idempotencyDigest, {
          phase: "publication",
          bundle: bundle.id,
          baseRevision: body.baseRevision,
          generationId: staged.generationId,
          message: typeof body.message === "string" ? body.message : "",
          fileCount: files.length,
          changes: {
            added: (preview.result.changes || {}).added || [],
            updated: (preview.result.changes || {}).updated || [],
            removed: (preview.result.changes || {}).removed || [],
          },
        });
        this.manager.patchIdempotency("submit", idempotencyKey, {
          status: "committing",
          expectedRevision: revisionForFiles(files),
        });

        if (typeof this.hooks.beforePointerSwitch === "function") {
          this.hooks.beforePointerSwitch({ staged });
        }
        // Activation: single atomic pointer switch to the verified generation.
        const activated = this.manager.activateGeneration(bundle, files, {
          generationId: staged.generationId,
          baseRevision: body.baseRevision,
          message: typeof body.message === "string" ? body.message : "",
        });
        if (typeof this.hooks.afterPointerSwitch === "function") {
          this.hooks.afterPointerSwitch({ staged, activated });
        }
        // Swap the prepared in-memory index without rebuilding.
        if (this.onPublished) {
          this.onPublished({
            result: null,
            index: staged.index,
            bundleArgs: staged.bundleArgs,
            activated,
          });
        }

        const result = {
          published: true,
          mode: "submit",
          bundle: bundle.id,
          generationId: activated.generationId,
          baseRevision: body.baseRevision,
          revision: activated.revision,
          fileCount: activated.manifest.fileCount,
          added: (preview.result.changes || {}).added || [],
          updated: (preview.result.changes || {}).updated || [],
          removed: (preview.result.changes || {}).removed || [],
          publishedAt: activated.manifest.createdAt,
          message: typeof body.message === "string" ? body.message : "",
          persistence: this.persistenceBoundary(bundle.id),
          materialization: activated.materialization,
        };
        if (typeof this.hooks.beforeIdempotencySave === "function") {
          this.hooks.beforeIdempotencySave({ result });
        }
        this.manager.finishIdempotency("submit", idempotencyKey, result);
        return result;
      });
    });
  }
}

function revisionForFiles(files) {
  const crypto = require("crypto");
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(files.map((file) => ({ path: file.path, sha256: file.sha256 })).sort((left, right) => left.path.localeCompare(right.path)))).digest("hex")}`;
}

function fsUnlinkIfExists(filePath) {
  try {
    require("fs").unlinkSync(filePath);
  } catch (_error) {
    // already gone
  }
}

module.exports = {
  DEFAULT_DIFF_PER_FILE_LIMIT_BYTES,
  DEFAULT_DIFF_TOTAL_LIMIT_BYTES,
  DEFAULT_PREVIEW_TTL_MS,
  SnapshotRolloutService,
  SnapshotConflictError,
  SnapshotNotFoundError,
  SnapshotValidationError,
  buildDiff,
  principalFromToken,
};
