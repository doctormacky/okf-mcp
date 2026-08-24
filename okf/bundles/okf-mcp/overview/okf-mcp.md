---
id: okf://okf-mcp/overview/okf-mcp
type: OKF Product
title: okf-mcp
description: Project-agnostic OKF CLI, graph index, MCP stdio/Streamable HTTP server, and controlled knowledge rollout runtime.
tags: [okf, mcp, runtime, knowledge-graph]
relations:
  - type: depends_on
    target: okf://okf-mcp/runtime/mcp-server
  - type: depends_on
    target: okf://okf-mcp/runtime/indexer
  - type: related_to
    target: okf://okf-mcp/interfaces/http-authoring-api
  - type: produces
    target: okf://okf-mcp/distribution/reference-bundle
  - type: configured_by
    target: repo://package.json
---

# okf-mcp

`okf-mcp` turns one OKF v0.2 root and its explicitly referenced inert assets into a searchable in-memory knowledge graph. It provides a CLI, SDK-backed stdio and Streamable HTTP MCP server, pinned Git-source reads, optional workspace federation, generator plugins, remote GitHub bundles, a legacy HTTP authoring API, and an authenticated immutable-snapshot rollout profile.

The runtime uses `js-yaml`, CommonMark, and a process-local MiniSearch BM25+ text index. It has no database, embedding service, computation executor, attester runtime, or build step. `--root` is the normal single-catalog interface and performs no network calls. The optional project manifest federates multiple roots and generator configuration; it is an okf-mcp extension rather than part of OKF v0.2.

The primary runtime entry is the [MCP server](../runtime/mcp-server.md). Concept interpretation and graph construction belong to the [indexer](../runtime/indexer.md). Durable knowledge changes follow either the local [concept authoring workflow](../workflows/concept-authoring.md) or the hosted snapshot rollout guarded by preview, confirmation, revision, validation, idempotency, and atomic generation activation.

The legacy `serve` command is an authoring API rather than an MCP transport. The `hosted` command is the remote quick-rollout profile: authenticated MCP Streamable HTTP and rollout REST share one active generation and index. The canonical architectural reference is this published reference bundle, shipped with source runtime archives and described for discovery by MCP metadata.
