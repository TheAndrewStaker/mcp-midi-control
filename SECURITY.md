# Security Policy

## Reporting a vulnerability

If you discover a security issue in this project (for example, a way
to exfiltrate data from the local machine, execute unintended commands
via crafted MCP input, or brick a connected AM4 via malicious SysEx),
please report it privately rather than opening a public issue.

**Contact:** stephenstaker@gmail.com

Please include:

- A description of the issue and its impact.
- Steps to reproduce (minimal example if possible).
- Your assessment of severity.
- Whether you have a suggested fix.

You will receive an acknowledgement within a reasonable time frame.
This is a small-scale community project; response times are on a
best-effort basis, not an SLA.

## Scope

In scope:

- The MCP server (`packages/server-all/src/`).
- The cross-device foundation (`packages/core/src/`).
- The vendor protocol layers (`packages/am4/src/`,
  `packages/fractal-gen1/src/`, `packages/fractal-gen2/src/`,
  `packages/fractal-gen3/src/`, `packages/hydrasynth/src/`).
- The codec package (`packages/fractal-midi/src/`): parses untrusted
  SysEx / capture input and is published independently to npm.
- Scripts under `scripts/` that process untrusted input (e.g. cache
  parsers, capture parsers).
- The distributed Windows release ZIP (`setup.cmd` + bundled Node runtime
  + the post-install PowerShell merge scripts).

Out of scope:

- Vulnerabilities in upstream dependencies (report those to the
  respective projects: `@modelcontextprotocol/sdk`, `node-midi`,
  `zod`, etc.).
- Issues that require an attacker to already have arbitrary code
  execution on the host.
- Social engineering attacks against the maintainer or users.
