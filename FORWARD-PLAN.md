# claude-compact-controller - Forward Plan

> Status: Installable, crash-safe zero-dep Node hook bundle; two headline features unverified against the live hook contract. Health: YELLOW. Last updated: 2026-06-27 (update on next session).

## Where this stands
**What it is:** A small, zero-dependency Node.js bundle of Claude Code lifecycle hooks that aims to prevent context loss during auto-compaction. Three coordinated hooks:
- **Stop hook** (`hooks/stop-hook.js`, matcher `''`) - fires after each response; tracks token/turn counters into `~/.claude/compact-controller/state.json`.
- **PreCompact hook** (`hooks/pre-compact.js`, matcher `auto`) - before auto-compaction, saves the transcript tail (default 50KB) to a timestamped `vault-*.json`, prunes old vaults, injects an `additionalContext` note.
- **PostCompact hook** (`hooks/post-compact.js`, matcher `auto`) - after compaction, injects a pointer to the latest vault and resets counters.

CLIs: `install.js` / `uninstall.js` patch `~/.claude/settings.json` (idempotent, backup-on-unparseable); `status.js` prints state + vault listing. `lib/shared.js` centralizes paths, stdin parsing, state/config load-save, logging.

**Build/run:** No build step, no deps. `npm run install-hooks`, `npm run uninstall-hooks`, `npm run status`. Requires `node` on PATH; hooks are invoked as `node "<path>"`. Restart Claude Code after install.

**Current state:** Brand-new repo - single commit (`8a8fc8e`) on master, 0 issues, 0 releases, 0 tags, no CI, no tests. All 7 JS files pass `node --check`. Every hook wraps logic in try/catch and exits 0 / emits `{continue:true}` on error, so it cannot crash or block Claude Code. The risk is correctness vs the hook contract, not build breakage.

## P0 - do first
> (Note: the "/.exe/installer" P0 item from the template applies to the cyber-controller repo, not this one. This is a pure-Node hook bundle with no compiled artifact; the equivalent first-order risks here are the hook-contract verification and the cross-repo install-path reconciliation.)

1. **Verify the live Claude Code hook contract before any feature work.** Two headline behaviors are contradicted by the official docs + community schema:
   - Does the **Stop hook stdin** actually carry `input_tokens` / `output_tokens`? (`hooks/stop-hook.js:25-26`)
   - Does **PostCompact** actually honor `hookSpecificOutput.additionalContext`? (`hooks/post-compact.js:46-51`)
   - Method: set `log_enabled: true` in `config.json`, temporarily log the raw pre-parse stdin from each hook, run a real session, and record which fields arrive. Everything below depends on this.
2. **Decide the canonical install path and reconcile with catalyst-ui.** catalyst-ui (`src/main/compact-controller.ts:9-13`) hardcodes `~/claude-compact-controller` and only recognizes hooks whose command contains `~/claude-compact-controller/hooks`; this clone is at `~/repos/claude-compact-controller`, so catalyst-ui's toggle/config-read won't see it. Pick one path, document it in the README, and align both repos.

## Surface bugs found
| Title | Location | Severity | Note |
|---|---|---|---|
| Stop hook reads token fields not in documented payload -> tracking likely always 0 | hooks/stop-hook.js:25-26 (used by pre-compact.js:52,86; post-compact.js:32; status.js) | P1 | Headline metric may be meaningless. Verify live; if absent, derive from transcript. |
| PostCompact additionalContext documented unsupported -> recovery pointer may be dropped | hooks/post-compact.js:46-51 | P1 | Defeats core purpose if true. Verify live; move to supported channel or document. |
| hookSpecificOutput omits required hookEventName | hooks/pre-compact.js:83-90, hooks/post-compact.js:47-51 | P2 | May cause additionalContext to be ignored even where supported (PreCompact). |
| Stop hook no-ops on empty/unparseable stdin (known Windows bug) | hooks/stop-hook.js:12 + lib/shared.js:28-33 | P2 | anthropics/claude-code#46601; this repo's own OS is Windows. Add fallback. |
| Non-atomic writes to shared state.json/config.json | lib/shared.js:54-57 (saveState), 59-69 (loadConfig) | P2 | catalyst-ui already uses atomic tmp+rename/0o600/.bak on the SAME shared files. |
| Vault pruning keeps maxVaults+1 files (off-by-one) | hooks/pre-compact.js:64-71 | P3 | slice(maxVaults) preserves index 0..maxVaults inclusive; keeps up to 11 of 10. |
| Lexicographic timestamp sort == "latest" assumption | hooks/pre-compact.js:64-67, post-compact.js:21-24 | P3 | Same-ms collision overwrites; any format change misorders silently. |
| install dedupe heuristic over-broad vs catalyst-ui's exact match | install.js:74-75 | P3 | `includes('compact-controller')` vs catalyst-ui exact `~/claude-compact-controller/hooks`; two installers can duplicate/orphan settings.json entries. |

## Features to add
- **User directives:** none were provided for this repo.
- **Publish a versioned data-contract doc** for `state.json` fields, `vault-*.json` filename pattern, and config keys - the implicit contract catalyst-ui depends on. Freeze the shape before changing anything.
- **`node status.js --json`** machine-readable output so catalyst-ui (and scripts) read a stable surface instead of re-parsing files.
- **`doctor` / self-check command**: print resolved install path, whether hooks are present in settings.json, the live contract findings (token fields? additionalContext honored?), and any catalyst-ui path mismatch.
- **Tag a real release.** package.json says 1.0.0 but there are no tags/releases; cut v1.0.0 (or bump after fixes) so installs are pinnable.
- **Make install path configurable** (env var/setting) so both the canonical `~/claude-compact-controller` location and arbitrary clones stay recognizable to catalyst-ui.

## Red-team / hardening
- **Atomic writes**: tmp+rename + restrictive mode for `state.json`/`config.json` (lib/shared.js:54-57), matching catalyst-ui, to avoid corruption when both tools write concurrently.
- **Vault contents are sensitive**: up to 50KB of raw transcript tail (may contain secrets/PII) lands in `~/.claude/compact-controller/vault/`. Document it, set restrictive permissions, never commit/sync vaults from this PUBLIC repo. (catalyst-ui syncs vaults to a PRIVATE repo - keep that boundary.)
- **Privileged settings.json write**: ensure idempotency + verified backup before every write, and re-validate the file round-trips as JSON after writing (install.js:87).
- **Two-installer interaction**: define one canonical hook command string both repos recognize so neither leaves orphaned/duplicate entries.
- **Public-repo discipline**: when documenting the Windows/contract issues, link upstream issue numbers and describe mitigations only - no session content, no user-path PII (session-context is private and intentionally holds PII; keep it out of here).

## Dig deeper (next dedicated session)
1. **Live-capture each hook's raw stdin** (log_enabled + raw pre-parse logging) through a real Stop/PreCompact/PostCompact cycle; record exactly which fields arrive. Resolves the two P0/P1 uncertainties empirically.
2. **Minimal smoke harness** (no deps): pipe canned JSON into each hook via stdin, assert on state.json mutations and stdout JSON shape; cover empty-stdin / BOM / CRLF (Windows #46601 path).
3. **CI** (`.github/workflows`): `node --check` all files + run the smoke harness on **both** ubuntu and windows runners (Windows-first tool with a known Windows stdin bug).
4. **Diff this repo's hooks/*.js against what catalyst-ui actually installs/ships** - confirm whether catalyst-ui bundles its own hook scripts or relies on this repo at the hardcoded path; establish the source of truth.
5. **Inspect LxveAce/claude-conversation-vaults** (private, not cloned) - confirm whether it is the canonical Phase-6 vault-sync destination and whether it constrains vault filename/JSON shape.
6. **Prototype context-size estimation from the transcript** if token fields are truly absent, so the headline metric and pruning have a real signal.
7. **Audit the full cross-repo contract surface**: enumerate every state/vault/config field read by catalyst-ui's compact-controller.ts, cost-service.ts, cloud-sync.ts; freeze in the shared schema doc before any shape change.

## Dependencies & cross-repo context
- **Runtime:** zero npm deps; pure Node (fs/path/os). No build. Needs `node` on PATH.
- **Hard external contract:** Claude Code hook system (Stop, PreCompact `auto`, PostCompact `auto`) and `~/.claude/settings.json` schema.
  - Docs: https://code.claude.com/docs/en/hooks
  - Hook input schemas: https://gist.github.com/FrancisBourre/50dca37124ecc43eaf08328cdcccdb34
  - Windows no-stdin bug: https://github.com/anthropics/claude-code/issues/46601
- **DOWNSTREAM CONSUMER (critical): catalyst-ui** (LxveAce/catalyst-ui, formerly "Claude Code Studio") reimplements this controller in TypeScript (`src/main/compact-controller.ts`, `src/renderer/components/compact/CompactPanel.tsx`) and layers `cost-service.ts` + `cloud-sync.ts` (Phase 6 vault sync) on top of the vault files. Changes to state.json shape, `vault-*.json` naming, config keys, or hook command path can break 3 catalyst-ui subsystems. catalyst-ui hardcodes `~/claude-compact-controller` as the install path.
- **Possibly related private repo:** LxveAce/claude-conversation-vaults ("conversation vault backups") - relationship to vault output / Phase-6 sync target unconfirmed.
- **Shared on-disk artifacts:** `~/.claude/compact-controller/state.json`, `~/.claude/compact-controller/vault/vault-*.json`, `config.json` (resolved via `__dirname/../config.json` here; hardcoded in catalyst-ui).
- **House rules (from continuity):** PUBLIC repo; commit as LxveAce with NO Claude co-author and noreply email; keep the standard Connect block; no PII.

## Open questions
- Does the installed Claude Code build actually pass `input_tokens`/`output_tokens` to the Stop hook? (Docs/schema say no; unconfirmed live.)
- Does PostCompact honor `hookSpecificOutput.additionalContext`, or is the docs table incomplete? (Unconfirmed live.)
- Does the missing `hookEventName` actually cause additionalContext to be ignored, or does Claude Code infer the event?
- Is the Windows no-stdin behavior (#46601) still present in the user's version or already fixed?
- Is this repo intended to live at `~/claude-compact-controller` (catalyst-ui's hardcoded path) or `~/repos/claude-compact-controller` (observed)? Mismatch may be a clone artifact, not a defect.
- Does catalyst-ui bundle its own hook scripts or rely on this repo at the hardcoded path? (Hook bytes not diffed.)
- What is LxveAce/claude-conversation-vaults, and is it the canonical Phase-6 sync destination? (Private; not fetched.)
- Any remote branches/issues/PRs not visible from the single-commit local clone?
