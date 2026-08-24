# Source Runtime Deployment

This project can be deployed to agent environments without an internal npm
registry. Prepare a complete runtime directory once, then distribute it as an
immutable artifact.

## Build The Runtime

Node.js 22 or newer is required.

```bash
git clone https://github.com/doctormacky/okf-mcp.git
cd okf-mcp
npm ci
npm test
npm run self:validate
npm run package:smoke
npm prune --omit=dev
node bin/okf-mcp.js --version
```

Package the source and production dependencies:

```bash
tar \
  --exclude=.git \
  --exclude=node_modules/.cache \
  -czf okf-mcp-runtime.tar.gz \
  bin src node_modules package.json package-lock.json okf .agents docs \
  okf.project.yaml server.json README.md README_zh.md LICENSE
```

Do not rebuild dependencies independently on every agent host. Build once,
verify once, and distribute the same artifact.

## Install On An Agent Host

```bash
mkdir -p /opt/okf-mcp-versions/0.9.0
tar -xzf okf-mcp-runtime.tar.gz -C /opt/okf-mcp-versions/0.9.0
ln -sfn /opt/okf-mcp-versions/0.9.0 /opt/okf-mcp-current
```

Create `/usr/local/bin/okf`:

```bash
#!/usr/bin/env bash
set -euo pipefail
exec node /opt/okf-mcp-current/bin/okf-mcp.js "$@"
```

Then verify:

```bash
chmod +x /usr/local/bin/okf
okf --version
okf knowledge --help
```

## Upgrade And Roll Back

Install each release into a new version directory. Switch the symlink only
after the new runtime passes its smoke tests:

```bash
ln -sfn /opt/okf-mcp-versions/<new-version> /opt/okf-mcp-current
```

Rollback uses the same operation with the previous version. Do not modify an
installed runtime directory in place.

## Credentials

The runtime artifact contains no credentials. Inject short-lived credentials
through the agent runtime, a secret file, OIDC workload identity, or mTLS.
Never store tokens in Skill files, OKF Markdown, command arguments, or the
runtime archive.

## Release Metadata Gate

`server.json` describes a future npm/MCP Registry identity. Do not submit it to
the MCP Registry until the exact package name and version have been published
to npm and verified from a clean environment with `npx`. Source distribution
does not imply that the Registry entry is installable.
