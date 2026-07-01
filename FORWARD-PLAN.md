# claude-compact-controller - Forward Plan

> Status: Installable, crash-safe zero-dep Node hook bundle. Token tracking, atomic writes, install dedupe, the data contract, a test suite, and CI have all landed; one headline behavior (post-compact recovery-pointer injection) remains unverified against the live hook contract. Health: nearly GREEN (blocked only on the live-contract check + a first tag). Last updated: 2026-06-30 (update on next session).

## Where this stands
**What it is:** A small, zero-dependency Node.js bundle of Claude Code lifecycle hooks that prevents context loss during auto-compaction. Three coordinated hooks:
- **Stop hook** (`hooks/stop-hook.js`, matcher `''`) - fires after each response; reads real usage from the session transcript (the Stop payload carries no token fields), tracks `input_tokens` (full context-window size) + cumulative `output_tokens` + a turn counter in `~/.claude/compact-controller/state.json`.
- **PreCompact hook** (`hooks/pre-compact.js`, matcher `auto`) - before auto-compaction, saves the transcript tail (default 50KB) to a timestamped `vault-*.json`, prunes to exactly `vault_max_entries` newest, records the real `trigger` (`auto`|`manual`), injects an `additionalContext` note.
- **SessionStart hook** (`hooks/post-compact.js`, matcher `compact`) - after auto/manual compaction, injects a pointer to the latest vault and resets counters. Must be SessionStart, not PostCompact: PostCompact has no decision control and cannot return `additionalContext` (verified against the Claude Code hook docs).

CLIs: `install.js` / `uninstall.js` patch `~/.claude/settings.json` (idempotent, path-based dedupe, backup-on-unparseable); `status.js` prints state + vault listing, or `--json` for the machine-readable surface. `lib/shared.js` centralizes paths, stdin parsing, atomic state/config load-save, transcript-usage parsing, logging.

**Build/run:** No build step, no deps. `npm run install-hooks`, `npm run uninstall-hooks`, `npm run status`, `npm test`. Requires `node` on PATH; hooks are invoked as `node "<path>"`. Restart Claude Code after install.

**Current state:** Multi-commit master with a green `node --test` suite (18 tests: token parser, all three hooks, install/uninstall dedupe, `status.js --json`) run on ubuntu + windows via `.github/workflows/test.yml`. The on-disk contract is frozen in `docs/DATA-CONTRACT.md`. Every hook wraps its logic in try/catch and exits 0 / emits `{continue:true}` on error, so it cannot crash or block Claude Code. The one remaining risk is correctness of the post-compact injection vs the live hook contract, not build breakage.

## P0 - do first
> (The "/.exe/installer" P0 from the template applies to the cyber-controller repo, not this one. This is a pure-Node hook bundle with no compiled artifact.)

1. **Verify the live Claude Code post-compact contract.** One headline behavior is still unconfirmed against a real compaction: does **PostCompact** (or `SessionStart` matcher `compact`) actually honor `hookSpecificOutput.additionalContext` so the recovery pointer reaches the model? Method: set `log_enabled: true` in `config.json`, log the raw pre-parse stdin from each hook, run a real auto-compact, and record which event fires and whether the injected context lands. If PostCompact injection is unsupported, move the pointer to the `SessionStart:compact` channel (keeping the PreCompact vault write unconditional). This is the gate on the "move post-compact injection" backlog item.

## Resolved since the first pass
| Was | Now |
|---|---|
| Stop hook read token fields absent from the Stop payload -> always 0/0 | Reads real `message.usage` from the transcript tail; covered by tests (`lib/shared.js` `readLatestUsageFromTranscript`). |
| Non-atomic writes to shared `state.json`/`config.json`/vaults | Atomic temp+rename, mode `0o600`, matching catalyst-ui (`lib/shared.js` `atomicWriteFileSync`). |
| Vault pruning kept `maxVaults+1` (off-by-one) | Keeps exactly `vault_max_entries` newest (`slice(0, -maxVaults)`). |
| `hookSpecificOutput` omitted required `hookEventName` | Present on both Pre/PostCompact outputs. |
| Stop hook fragile on empty/BOM/CRLF stdin (Windows #46601) | Robust stdin (BOM strip, CRLF normalize, empty -> null); tested. |
| Install dedupe used loose `compact-controller` substring | Path-based ownership match on the resolved hooks dir, aligned with catalyst-ui `isOurHookCommand`; idempotent install tested. |
| Install path hardcoded / mismatched with catalyst-ui | Configurable via `CLAUDE_COMPACT_CONTROLLER_HOME` (defaults to the script dir). |
| No data contract; catalyst-ui coupled to an implicit shape | `docs/DATA-CONTRACT.md` freezes state/vault/config + `status.js --json`. |
| New-session reset left `input_tokens`/`last_vault_file` stale next to `vault_count:0` | All session-scoped fields reset together. |
| No tests, no CI | `npm test` (18 tests) + ubuntu/windows CI. |

## Still open
| Title | Location | Severity | Note |
|---|---|---|---|
| ~~PostCompact `additionalContext` dropped~~ FIXED — moved to `SessionStart:compact` | hooks/post-compact.js | done | PostCompact has no decision control (docs-verified); recovery pointer now injected via SessionStart. Vault FILE write unaffected. |
| Divergent git history (local orphan vs origin superset) | repo history | P2 | Owner-gated reconciliation; do not rewrite published history autonomously. |
| Lexicographic timestamp sort == "latest" assumption | pre-compact.js / post-compact.js | P3 | Same-millisecond collision would overwrite; any timestamp-format change misorders silently. |
| Orphaned `.vault-*.tmp` files on mid-write crash | lib/shared.js atomicWriteFileSync | P3 | Temp files are excluded from vault listing/pruning (`vault-` prefix), so harmless, but they accumulate on crash. |

## Features to add
- **`doctor` / self-check command**: print the resolved install path, whether hooks are present in `settings.json`, the live-contract findings, and any catalyst-ui path mismatch.
- **Tag a real release** (owner-gated): `package.json` says `1.0.0` but there are no tags/releases; cut a tag so installs are pinnable. Sequence after the live-contract check.
- **Optional transcript redaction** for vaults, given `transcript_tail` may hold secrets (already documented as owner-only `0o600` + private-repo-only).

## Red-team / hardening
- **Atomic writes** landed for `state.json`/`config.json`/vaults (tmp+rename + `0o600`). `install.js` still writes `settings.json` with a plain `writeFileSync` (backs up on unparseable read, but the write itself is non-atomic) - candidate for the same tmp+rename treatment if the owner wants belt-and-suspenders on the user's real config.
- **Vault contents are sensitive**: up to 50KB of raw transcript tail (may contain secrets/PII) lands in `~/.claude/compact-controller/vault/`. Owner-only perms + private-repo-only sync are documented; never commit/sync vaults from this PUBLIC repo. (catalyst-ui syncs vaults to a PRIVATE repo - keep that boundary.)
- **Two-installer interaction**: the path-based dedupe now matches catalyst-ui's `isOurHookCommand`, so neither tool leaves orphaned/duplicate entries.
- **Public-repo discipline**: document Windows/contract issues by linking upstream issue numbers and describing mitigations only - no session content, no user-path PII.

## Dig deeper (next dedicated session)
1. **Live-capture the post-compact cycle** (log_enabled + raw pre-parse logging) through a real auto-compact; record exactly which event fires and whether the injected context reaches the model. Resolves the remaining P0/P1.
2. **Diff this repo's hooks/*.js against what catalyst-ui actually installs/ships** - confirm whether catalyst-ui bundles its own hook scripts or relies on this repo at the hardcoded path; establish the source of truth.
3. **Inspect LxveAce/claude-conversation-vaults** (private, not cloned) - confirm whether it is the canonical Phase-6 vault-sync destination and whether it constrains vault filename/JSON shape.
4. **Reconcile the divergent git history** onto the canonical line (owner-gated) once the P0 is closed.

## Dependencies & cross-repo context
- **Runtime:** zero npm deps; pure Node (fs/path/os). No build. Needs `node` on PATH.
- **Hard external contract:** Claude Code hook system (Stop, PreCompact `auto`, PostCompact `auto`) and `~/.claude/settings.json` schema.
  - Docs: https://code.claude.com/docs/en/hooks
  - Hook input schemas: https://gist.github.com/FrancisBourre/50dca37124ecc43eaf08328cdcccdb34
  - Windows no-stdin bug: https://github.com/anthropics/claude-code/issues/46601
- **DOWNSTREAM CONSUMER (critical): catalyst-ui** (LxveAce/catalyst-ui, formerly "Claude Code Studio") reimplements this controller in TypeScript (`src/main/compact-controller.ts`, `src/renderer/components/compact/CompactPanel.tsx`) and layers `cost-service.ts` + `cloud-sync.ts` (Phase 6 vault sync) on top of the vault files. Changes to state.json shape, `vault-*.json` naming, config keys, or hook command path can break 3 catalyst-ui subsystems - all now frozen in `docs/DATA-CONTRACT.md`. Once token values are non-zero end to end, confirm catalyst-ui renders them correctly (it previously consumed zeros).
- **Possibly related private repo:** LxveAce/claude-conversation-vaults ("conversation vault backups") - relationship to vault output / Phase-6 sync target unconfirmed.
- **Shared on-disk artifacts:** `~/.claude/compact-controller/state.json`, `~/.claude/compact-controller/vault/vault-*.json`, `config.json` (resolved as `<install-home>/config.json`; hardcoded in catalyst-ui).
- **House rules (from continuity):** PUBLIC repo; commit as LxveAce with NO Claude co-author and noreply email; keep the standard Connect block; no PII.

## Open questions
- RESOLVED (docs-verified): PostCompact has no decision control and cannot inject `additionalContext`, so the recovery pointer is injected via the `SessionStart:compact` hook. A live end-to-end confirmation on a real auto-compaction is still worth doing.
- Is the Windows no-stdin behavior (#46601) still present in the user's version or already fixed? (Mitigated regardless by robust stdin handling.)
- Does catalyst-ui bundle its own hook scripts or rely on this repo at the resolved path? (Hook bytes not diffed.)
- What is LxveAce/claude-conversation-vaults, and is it the canonical Phase-6 sync destination? (Private; not fetched.)
- When should the divergent local/origin history be reconciled, and what is the canonical line? (Owner-gated.)
