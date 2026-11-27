# Release Runbook

End-to-end checklist for cutting a release. Walk it top to bottom. Each step
names what "done" looks like and what has gone wrong before.

The release model (see `CLAUDE.md`, "Versioning and releases"): one squashed
commit per release on top of the previous release commit, carrying the version
bump, an annotated `v<x.y.z>` tag, one `CHANGELOG.md` entry, the GitHub release
the tag push triggers, and the `fractal-midi` npm publish at the same version.

> The assistant never pushes `main` and never publishes. It prepares the
> release commit, the tag and a push checklist; the maintainer runs the push
> and the publish.

---

## 0. Scope

- [ ] Decide the version. Patch = fixes only; minor = a new tool, capability
      or device. Read `git log <last release commit>..HEAD` against the
      `[Unreleased]` CHANGELOG entry so nothing shipped is missing from it and
      nothing in it is overstated.
- [ ] Every device whose behaviour changed has its asks and status updated on
      `docs/contributing/devices/<id>.md` (preflight checks the tier and
      transport, not the prose).

## 1. Gates that need no device

`npm run release-gate` chains everything below plus the hardware gates; run
the parts separately so a hardware absence does not hide a software failure.

| Command | Notes |
|---|---|
| `npm run preflight` | Build, typecheck, every test, the size and docs gates. Also rebuilds `dist/`, which Claude Desktop runs |
| `npx tsx scripts/primitives-verify.ts --strict` | Strict corpus check |
| `npx tsx scripts/verify-re-ledger.ts --strict` | Fails on research items older than 60 days unless re-mined or marked `(deferred: YYYY-MM-DD reason)` with a real reason |
| `npm run test:release-extras` | Verify chain, lineage resources, coverage audit |
| `npm run build:installer` then `npm run verify-release-zip` | **Not in preflight, but the tag workflow runs it.** Extracts the ZIP into a clean temp dir, boots the bundled node, `describe_device` on every device, and a mock Axe-Fx II apply / read / export / translate. It has caught a release-breaking failure two releases running; never tag without it |
| `npm run build:mcpb` then `npm run verify-mcpb-bundle` | The Claude Desktop extension (win32-x64 only today) |

A push to a `release/**` branch also runs `.github/workflows/release-bundle.yml`,
which builds and verifies the ZIP on a clean Windows runner before any tag
exists.

## 2. Hardware pass

Run with the devices whose behaviour changed. Each harness skips absent
devices.

**Free the ports first.** The harnesses start their own server, so nothing
else may be using the devices:

- Fully quit Claude Desktop (from the tray; closing the window leaves its
  server running). Close AM4-Edit, Axe-Edit and the other vendor editors.
- A Claude Code session in this folder may stay connected **if it makes no
  device tool call** during the run: the server opens a port only on a device
  call. The Axe-Fx II is the exception: once any call touches it, that server
  keeps its port for the rest of its life, so restart that session's server
  first (`/mcp` > reconnect) and leave it untouched.
- Do **not** use `/mcp` > disable to free the ports. It is saved per folder,
  and the agent sweep's own `claude -p` children then start with the server
  disabled; the sweep's preflight refuses with "MCP disabled".

| Command | What it does |
|---|---|
| `npm run launch-verify` | Reads plus self-restoring writes on every connected device. No saves |
| `npm run live-regression` | Reads, identity writes and refused writes |
| `npm run agent-sweep:<device>:real` | A real agent drives the device through its regression cases; working-buffer edits only. Costs model usage |

Then exercise each new behaviour once through the real MCP tools in a session
(the shipped path), against the front panel. Use scratch locations only, and
never save over a preset that is not yours to replace.

## 3. Release prep (on the development branch)

- [ ] Bump `version` in the root and every workspace `package.json`
      (including `packages/fractal-midi`) to the release version.
- [ ] Rename `[Unreleased]` in `CHANGELOG.md` to `[x.y.z] - YYYY-MM-DD`. The
      tag workflow copies this section into the GitHub release, matching the
      heading exactly.
- [ ] `npm run preflight` again after the bump.
- [ ] Rebuild and re-verify both artifacts from this exact tree
      (`build:installer` + `verify-release-zip`, `build:mcpb` +
      `verify-mcpb-bundle`). Artifacts built before the last code change do
      not count.

## 4. Squash and tag (local)

- [ ] Back up the pre-squash history on a branch named
      `backup/pre-<x.y.z>-squash`. Never push it.
- [ ] Create one commit on `main`, parent = the previous release commit,
      whose tree is byte-identical to the verified development tip. Verify
      with `git diff <dev tip> main` (empty).
- [ ] Annotated tag: `git tag -a v<x.y.z> -m "<x.y.z>: <summary>"` on that
      commit.
- [ ] Write the push checklist for the maintainer: the commit, its parent,
      the tag, the gates that ran and their results, what was NOT run, and the
      known issues for the release notes.

## 5. Push and publish (maintainer)

```
git push origin main
git push origin v<x.y.z>
cd packages/fractal-midi && npm publish
```

The tag push runs `.github/workflows/release.yml`: it checks the tag against
`package.json`, runs preflight, builds and verifies the ZIP, and creates the
GitHub release with the versioned and stable-named Windows ZIPs, the SHA256
and the CHANGELOG section. Watch it to the end. macOS and Linux users install
from `main`, so the branch push matters as much as the tag.

## 6. After the release

- [ ] Confirm the release page, the download, and `npm view fractal-midi
      version`.
- [ ] Follow up on the GitHub issues the release closes (owner-approved text).
- [ ] Watch for install reports in the first days.

## Clean-machine smoke test

When the installer, `setup.cmd`, the bundled Node version or the config merge
changes, also test the ZIP on a Windows 11 machine with no Node or developer
tools: extract (to a path with spaces too), run `setup.cmd`, check the
`mcp-midi-control` entry in `claude_desktop_config.json`, relaunch Claude
Desktop, list the MIDI ports, build one tone, then run `uninstall.cmd` and
confirm only our entry is removed.

## Rollback

If a release ships with a critical bug:

1. Mark the GitHub release as a draft or withdrawn, which removes the
   download link.
2. Say so wherever the release was announced. Do not update silently.
3. Fix, and run this runbook for the next patch version.
4. Do not delete the tag. It is history; mark the release "(withdrawn)".

If the installer damages a user's environment, pull the release immediately,
publish manual clean-up steps, and file a post-mortem before the next release.
