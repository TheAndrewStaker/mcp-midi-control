# Release Runbook: v0.1.0 (and future versions)

End-to-end checklist for shipping a public release. Walk this top to
bottom; each step has acceptance criteria and a "what could go wrong"
note. Audience-specific announce work is tracked in the project's own
private launch plan.

> v0.1.0 ships **unsigned**. Users will see a Windows SmartScreen
> "unrecognized publisher" warning. Decision logged 2026-05-03.

---

## 0. Pre-flight (everything must be green before starting)

- [ ] `npm run preflight` exits zero (`tsc --noEmit` + all golden
      verifiers + `smoke-server`).
- [ ] No uncommitted changes that won't ship in this release.
- [ ] Any release-readiness gates that live in a local launch plan
      are ticked off (or every unticked item is consciously deferred).
- [ ] `README.md` install section reflects the installer flow (not
      clone-and-run).
- [ ] No personal credentials, API keys, or secrets tracked in git
      (re-grep `.env`, `secret`, `credential`, `password`, `token`,
      `api_key` against `git ls-files` if it has been a while).

---

## 1. Build the release bundle and ZIP

```
npm run build:installer
```

Acceptance:

- Last line says `OK release bundle ready`.
- `build/staging/node.exe` reports the pinned Node version when run
  with `--version`.
- `@julusian/midi` loads + enumerates under the bundled node (the build
  script load-tests this; the prebuilt binary lives at
  `build/staging/node_modules/@julusian/midi/prebuilds/midi-<plat>-<arch>/node-napi-v7.node`).
- `build/staging/dist/server/index.js` exists.
- `build/staging/setup.cmd`, `build/staging/uninstall.cmd`, and
  `build/staging/install/{merge,unmerge}-mcp-config.ps1` all present.
- `build/dist/mcp-midi-control-v0.1.0.zip` exists (typically 25-40 MB
  compressed; staging is 50-80 MB uncompressed).

If it fails:

- **Native module missing**: bundled Node and PATH Node are
  ABI-mismatched. The build script uses bundled npm to avoid this, but
  a corrupt cache can defeat it. Re-run with `npm run build:installer -- --clean`.
- **Network error on Node download**: check connectivity and retry. The
  Node ZIP is cached locally; subsequent builds skip the download.
- **Compress-Archive errors**: PowerShell's Compress-Archive has a
  ~2 GB limit, well above what we ship. If it fails for permission
  reasons, ensure `build/dist/` is not held open by another process
  (closing any explorer window viewing it usually fixes it).

---

## 2. Smoke-test the ZIP on a clean Windows 11 VM

This is the gate that decides whether the release ships. The dev
machine is too contaminated (Node on PATH, prior MCP servers, debug
state) to be a meaningful test.

VM requirements: Windows 11, no Node, no developer tooling. Claude
Desktop installed (direct download from claude.ai/download is
preferred; the Microsoft Store variant works too but lives at a
different config path that the merge script also handles).

Test sequence:

- [ ] Copy `mcp-midi-control-v0.1.0.zip` to the VM (or download it from
      a draft GitHub release).
- [ ] Right-click the ZIP -> Properties -> tick **Unblock** -> OK. Verify
      the warning behavior matches what `instructions.txt` describes.
- [ ] Extract to a folder of your choice (test both
      `C:\Users\<you>\Apps\` and a path with spaces like
      `C:\Users\<you>\Documents\My Apps\` so we know spaces work).
- [ ] Double-click `setup.cmd`. A console window opens, runs the
      merge script, and waits for a key.
- [ ] Open `%APPDATA%\Claude\claude_desktop_config.json` in a text
      editor. Confirm `mcpServers["mcp-midi-control"]` entry exists with
      `command` pointing at the extracted `node.exe` and `args[0]` at
      the extracted `dist\server\index.js`. Paths must match the
      actual extract location.
- [ ] Open Claude Desktop. Start a new chat. The MCP MIDI Control
      connector appears in the tools panel.
- [ ] Plug in the AM4 (or have it plugged in beforehand).
- [ ] Ask Claude: *"Using mcp-midi-control, list the MIDI ports you can
      see."* Expect AM4 to be detected.
- [ ] Ask Claude one full iconic-tone prompt (e.g. *"Build me a clean
      Fender tone with a touch of spring reverb on Z04."*). Watch the
      AM4 display update.
- [ ] Verify uninstall: double-click `uninstall.cmd`, confirm the
      `mcp-midi-control` entry is gone from
      `claude_desktop_config.json` (other MCP servers intact), then
      delete the extracted folder.
- [ ] Optional: rerun setup.cmd from a different extracted folder
      and confirm the config gets re-pointed at the new location
      (idempotency check).

If anything in this list falls over, do not ship. Fix and re-test.

---

## 3. Tag and prepare the GitHub release

> Reminder: `origin/main` is never pushed by Claude. Tagging and
> pushing are maintainer actions. Claude can prepare the commands but
> the maintainer runs them.

- [ ] Confirm `package.json` version matches the release (currently
      `0.1.0`).
- [ ] Tag the release locally:
      ```
      git tag -a v0.1.0 -m "v0.1.0 public launch"
      ```
- [ ] Push the tag:
      ```
      git push origin v0.1.0
      ```

---

## 4. Repo flip private -> public

Until this step, the repo is private and the world can't see it.
After this step, every prior commit and doc is public. Last chance to
review.

- [ ] Walk `git log --all --pretty=oneline | head -50` for any commits
      with sensitive content in the message.
- [ ] Confirm `git ls-files` does not include any `.env`, captures with
      sensitive data, or scratch files that shouldn't be public.
- [ ] On GitHub: Settings -> Danger Zone -> Change visibility -> Public.
      Confirm.

---

## 5. Create the GitHub release

- [ ] On GitHub: Releases -> Draft a new release.
- [ ] Choose tag `v0.1.0`. Title: `v0.1.0 public launch`.
- [ ] Attach `build/dist/mcp-midi-control-v0.1.0.zip`.
- [ ] Body: short release notes (what's in, what's not, link to any
      community thread once posted). Draft is fine; it can be edited
      after publishing.
- [ ] Publish the release.
- [ ] Verify the download URL works from a fresh browser (incognito)
      and the ZIP downloads with the correct Mark-of-the-Web behavior
      (right-click Properties shows the Unblock checkbox).

---

## 6. Announce per your project's launch strategy

The actual announce (community thread, social posts, demo video,
talking points) is project-strategic and lives outside this runbook;
keep it in a local launch plan that you maintain separately. From
this runbook's perspective, the steps are:

- [ ] Post wherever your audience reads (forum thread, mailing list,
      social) per your launch plan.
- [ ] Link the GitHub release artefacts from the post.
- [ ] Watch the channel for replies in the first 24 hours.

---

## 7. Monitor early adopters (first 24 hours)

- [ ] If install bug reports come in, file them as GitHub issues with
      the OS / Claude Desktop variant. Patch in v0.1.1 if blocking.
- [ ] If SmartScreen friction is hurting adoption (multiple users
      report bouncing on the warning), surface that as the trigger to
      revisit the cert decision.

---

## Rollback / hotfix procedure

If the release goes out and a critical bug is found:

1. **Pull the GitHub release** (mark it as a draft or delete it). This
   removes the download link.
2. **Update wherever you announced** with a clear "v0.1.0 has been
   pulled, fix in progress" notice. Do not silently update; be
   explicit.
3. Patch the bug. Run the full runbook for v0.1.1.
4. **Do not delete the v0.1.0 git tag.** It is part of the project
   history. Mark the GitHub release as "v0.1.0 (withdrawn)" rather
   than removing the tag.

Catastrophic case (e.g. installer corrupts user environment):

1. Pull the release immediately.
2. Post a public advisory with steps to manually clean up.
3. File a public post-mortem in the repo before shipping any further
   versions.

---

## Versions

| Version | Date | Notes |
|---|---|---|
| 0.1.0 | TBD | First public release. AM4 working-buffer support; unsigned ZIP. |
