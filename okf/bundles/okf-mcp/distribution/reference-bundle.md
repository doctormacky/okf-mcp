---
id: okf://okf-mcp/distribution/reference-bundle
type: OKF Distribution
title: Published okf-mcp Reference Bundle
description: Canonical public OKF bundle describing the okf-mcp product and its durable contracts.
tags: [distribution, reference, remote-bundle, dogfooding]
relations:
  - type: consumes
    target: okf://okf-mcp/specs/concept-format
  - type: related_to
    target: okf://okf-mcp/overview/okf-mcp
  - type: checked_by
    target: repo://test/okf-mcp.test.js
  - type: checked_by
    target: repo://scripts/package-smoke.js
  - type: configured_by
    target: repo://okf.project.yaml
  - type: configured_by
    target: repo://package.json
  - type: configured_by
    target: repo://server.json
---

# Published okf-mcp Reference Bundle

This directory is the canonical machine-readable architectural reference for `okf-mcp`. It is maintained with the source repository and validated by the same runtime it documents.

The latest public bundle can be loaded from:

`https://github.com/doctormacky/okf-mcp/tree/main/okf/bundles/okf-mcp`

Consumers that need reproducibility should replace `main` with a release tag. Remote loading indexes only the Markdown tree and does not execute repository code.

This fork uses the source package identity `@doctormacky/okf-mcp` and MCP Registry name `io.github.doctormacky/okf-mcp`. Its package allowlist includes `okf.project.yaml`, `server.json`, the `okf` directory, both README languages, docs, and bundled Skills so source runtime archives carry the same reference and metadata. The original upstream project remains credited in the repository README and MIT License.

The package smoke gate verifies that package, lockfile, CLI, MCP server, and metadata versions and identities agree. It installs the generated tarball into a clean temporary project, executes both binaries, validates this bundle, exercises modern and legacy stdio sessions, and boots the authenticated hosted profile to verify Streamable HTTP tools, resources, and rollout authorization.

The repository is currently source-distributed. CI runs `npm test`, `npm run self:validate`, and `npm run package:smoke` on supported Node versions. A manual release builds the verified source runtime archive after those gates pass. npm and MCP Registry publication are intentionally not automated for this fork; `server.json` must not be submitted to the Registry until the matching npm package and version exist and clean `npx` verification succeeds.

Portable Concept IDs are extensionless paths inside this root. `okf://okf-mcp/...` remains a deterministic MCP/workspace locator, while `repo://` references connect durable concepts to implementation sources without turning source files into concepts.

The bundle deliberately documents product contracts, runtime boundaries, workflows, and policies rather than mirroring every source file.
