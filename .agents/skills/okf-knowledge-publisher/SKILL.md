---
name: okf-knowledge-publisher
description: Use this skill when the user wants to publish or update the central OKF v0.2 knowledge base through a controlled workspace workflow that downloads the current snapshot, previews server-side changes, requires explicit confirmation, submits through the okf knowledge CLI, and verifies through remote MCP. Do not use merely to read published knowledge or edit a local database Bundle.
---

# Publish OKF Knowledge

Follow this workflow exactly:

```text
download -> enrich -> server dry-run -> explicit confirmation -> submit -> MCP verify
```

## Boundaries

- Read and query published knowledge through the configured remote MCP server.
- Download, dry-run, and submit through the `okf knowledge` CLI.
- Do not call private HTTP endpoints directly.
- Do not use MCP write tools for this workflow.
- Do not install or upgrade the CLI automatically.
- Never put credentials in this Skill, the OKF bundle, command arguments, or logs.
- A successful dry-run is not approval to submit.

## 1. Check The Runtime

Before changing knowledge, run:

```bash
command -v okf
okf --version
okf knowledge --help
```

If `okf` is missing or lacks the `knowledge` command, stop and report that the
agent runtime must be updated. Do not use `curl`, `npm install`, or direct HTTP
requests as a workaround.

## 2. Confirm The Target

Confirm the server, bundle, local workspace, and intended knowledge scope. Use
MCP `list_bundles` when the bundle is not known. Never guess a bundle ID.

## 3. Download The Current Snapshot

```bash
okf knowledge download \
  --url https://knowledge.internal.example \
  --out ./okf-work
```

When the hosted service contains more than one writable bundle, also pass the
confirmed `--bundle <id>` value.

Treat the returned revision as mandatory baseline state. Work only inside the
downloaded workspace. Do not wrap its files in an extra bundle directory.

## 4. Enrich Locally

Apply OKF v0.2 rules:

- every non-reserved Markdown concept has YAML frontmatter and non-empty `type`;
- preserve unknown frontmatter and extension fields;
- prefer native v0.2 `generated`, `sources`, lifecycle, and relation fields;
- use safe bundle-relative Markdown paths;
- do not invent facts, schemas, URLs, sources, or identifiers;
- keep concept paths stable during updates;
- removing a file expresses an intended deletion and must be called out clearly.

Local validation is useful but does not replace the server preview.

## 5. Run The Server Dry-Run

```bash
okf knowledge submit --workspace ./okf-work --dry-run
```

Show the user the server-returned path changes, bounded `diffText`, truncation
metadata, validation diagnostics, submitted/current revision, preview ID, and
candidate digest. Do not substitute a locally calculated
diff for the server result.

## 6. Require Explicit Confirmation

Wait for an unambiguous confirmation such as `确认提交`. The original request to
update knowledge, a successful validation, or a statement such as `继续检查`
does not authorize submission.

Confirmation is valid only for the displayed preview. If any workspace file
changes after the preview, run the dry-run again and request confirmation again.

## 7. Submit

After confirmation, submit the exact previewed workspace:

```bash
okf knowledge submit \
  --workspace ./okf-work \
  --preview-id <preview-id> \
  --message "<concise change description>"
```

The server must recheck the base revision, candidate digest, OKF validation,
and complete future index before publishing.

## 8. Handle Conflicts

On `409 Conflict`:

1. stop; never force or overwrite;
2. download the latest snapshot into a fresh workspace;
3. reapply the user's intended changes to the new baseline;
4. run the server dry-run again;
5. show the new diff and obtain confirmation again;
6. submit using the new preview.

On validation errors, show the file-specific diagnostics, fix the workspace,
and restart from dry-run. On authentication or authorization errors, stop and
report the failure without attempting a bypass.

## 9. Verify Through MCP

After submission, verify the published result through remote MCP rather than
the server filesystem:

1. call `get_concept` for the primary changed concepts;
2. call `search_concepts` to confirm new knowledge is searchable;
3. call `get_neighbors` or `get_graph` when relations changed;
4. confirm the returned revision matches the published revision.

Only report completion after this verification succeeds. If publication
succeeded but MCP verification is temporarily unavailable, report the
published revision and the verification failure; do not resubmit.

## Expected User-Facing Summary

Report:

- the published revision;
- added, modified, and deleted concept counts;
- the concepts verified through MCP;
- warnings that remain;
- any verification that could not be completed.
