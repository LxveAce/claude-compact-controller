# Claude Compact Controller

> Provided **as is**, without warranty; you use it at your own risk. See [DISCLAIMER.md](DISCLAIMER.md).

Smart auto-compact management for Claude Code. Prevents context loss during compaction by saving vault backups of conversation state and injecting recovery references after the compact runs.

Zero dependencies — just Node.js (which ships with Claude Code) and three small hook scripts.

<!-- STATUS-ROADMAP:START -->
## Status & Roadmap

**Status:** Installable, crash-safe, zero-dependency hook bundle; the install/uninstall/status flow and fail-safe error handling are working. Token tracking now reads real usage from the session transcript (the Stop payload itself carries no token fields) and is covered by an automated test suite. The post-compact recovery pointer is injected through the **SessionStart `compact`** hook — the correct channel per the Claude Code hook contract, since PostCompact has no decision control and cannot return `additionalContext`. Health: actively under development.

**In progress / known issues:**
- The post-compact recovery pointer now uses the SessionStart `compact` hook (the event class that supports `additionalContext`; PostCompact does not) — a live end-to-end confirmation on a real auto-compaction is still worth doing. The pre-compact vault backup file is written unconditionally regardless.
- Once token values are non-zero end to end, confirm the downstream catalyst-ui consumer renders them correctly (it previously consumed zeros).

**Recently landed:**
- Transcript-based token tracking (replaces the always-zero Stop-payload read).
- Atomic, owner-only (`0o600`) writes for shared state/config/vault files.
- Machine-readable `node status.js --json` output, frozen in `docs/DATA-CONTRACT.md`.
- Configurable install path (`CLAUDE_COMPACT_CONTROLLER_HOME`) with path-based, catalyst-ui-aligned hook dedupe.
- BOM/CRLF/empty-safe stdin handling for Windows PowerShell pipes.
- A minimal, dependency-free test suite (`npm test`) plus CI.

**Roadmap:**
- Add a `doctor` / self-check command (resolved install path, hooks present in settings, live-contract findings, path-mismatch detection).
<!-- STATUS-ROADMAP:END -->

## Problem

When Claude Code auto-compacts, it summarizes the conversation to free up context-window space. That summary can drop details Claude was relying on — files it edited, decisions it made, or multi-step operations still in progress. The Compact Controller wraps the compact lifecycle so a full backup is captured first and a pointer back to it is handed to Claude afterward.

## How It Works

Three hooks work together across the auto-compact lifecycle:

1. **Stop hook** — fires after every Claude response. Reads the latest usage from the session transcript (the Stop payload carries no token fields) to track the current context-window size (`input_tokens`), accumulates output tokens across turns, and increments a turn counter in a persistent state file. Counters reset automatically when a new session starts.

2. **PreCompact hook** (matcher `auto`) — fires right before auto-compaction. Reads the tail of the conversation transcript and writes it to a timestamped vault file, then prunes old vaults beyond the retention limit. Injects an `additionalContext` message so Claude knows a backup was saved.

3. **SessionStart hook** (matcher `compact`) — fires right after auto or manual compaction. Injects a message pointing Claude to the most recent vault file so it can recover any lost context, then resets the token/turn counters for fresh post-compact tracking. (It runs `hooks/post-compact.js`; it must be SessionStart, not PostCompact — only SessionStart-class events can inject `additionalContext` into the model.)

```
Normal operation:        Stop hook tracks tokens each turn
                              |
Auto-compact triggers:   PreCompact saves vault backup + prunes old vaults
                              |
Compact runs:            Conversation is summarized
                              |
Post-compact:            SessionStart(compact) injects vault reference, resets counters
                              |
Claude continues:        Can read the vault file if context was lost
```

Hooks are designed to fail safe — any error is swallowed so the controller can never crash Claude Code or block a compaction.

## Install

```bash
cd claude-compact-controller
node install.js
```

This appends three hooks to your user-level `~/.claude/settings.json` (Stop, PreCompact `auto`, SessionStart `compact`) and creates the runtime directories. It is safe to run multiple times — already-installed hooks are detected and skipped, and existing unrelated hooks are preserved. If your settings file exists but can't be parsed, it is backed up to `settings.json.bak` before being rewritten.

Hook ownership is detected by the resolved hooks-directory path (an exact path match, the same scheme `catalyst-ui` uses), so installs by either tool are recognized and never duplicated.

Restart Claude Code after installing for the hooks to take effect.

### Install path

By default the installer registers hooks from the directory it is run from, so both the canonical `~/claude-compact-controller` location and arbitrary clones work. To pin a specific install root, set `CLAUDE_COMPACT_CONTROLLER_HOME` before running install/uninstall:

```bash
CLAUDE_COMPACT_CONTROLLER_HOME=/opt/claude-compact-controller node install.js
```

The same variable controls where `config.json` is resolved from.

## Uninstall

```bash
node uninstall.js
```

Removes only the controller's hooks from settings (other hooks are left intact). Vault data is preserved on disk for manual cleanup.

## Check Status

```bash
node status.js
```

Prints the current token-tracking state (session, context tokens, output tokens, turns, vaults created) and lists all vault backups with their timestamps, turn counts, and token estimates.

For a stable, machine-readable surface (consumed by tools such as catalyst-ui), use:

```bash
node status.js --json
```

This emits the full state plus a vault listing as JSON with a `schema_version` field. The exact shape is frozen in [`docs/DATA-CONTRACT.md`](docs/DATA-CONTRACT.md).

## Configuration

Edit `config.json`:

| Key | Default | Description |
|-----|---------|-------------|
| `vault_max_entries` | `10` | Max vault backups to keep (oldest pruned first) |
| `vault_transcript_tail_bytes` | `50000` | Bytes of transcript tail saved per vault (~12k tokens) |
| `log_enabled` | `false` | Enable debug logging to `~/.claude/compact-controller/controller.log` |

## File Layout

```
claude-compact-controller/          # This repo
├── hooks/
│   ├── stop-hook.js                # Token tracking (Stop event)
│   ├── pre-compact.js              # Vault backup (PreCompact event)
│   └── post-compact.js             # Vault reference injection (SessionStart:compact event)
├── lib/
│   └── shared.js                   # Shared utilities (paths, state, config, stdin, logging)
├── config.json                     # Configuration
├── install.js                      # Hook installer
├── uninstall.js                    # Hook remover
└── status.js                       # Status checker

~/.claude/compact-controller/       # Runtime data (created automatically)
├── state.json                      # Current session tracking
├── controller.log                  # Debug log (if log_enabled)
└── vault/
    ├── vault-2026-05-21T14-30-00-000Z.json
    └── ...                         # Timestamped vault backups
```

## Vault Format

Each vault file is JSON (values below are illustrative):

```json
{
    "timestamp": "2026-05-21T14:30:00.000Z",
    "session_id": "abc123",
    "trigger": "auto",
    "context_tokens": 185000,
    "output_tokens_total": 42000,
    "turn_count": 47,
    "cwd": "/path/to/project",
    "transcript_tail": "... last ~50KB of conversation ..."
}
```

> **Privacy:** `transcript_tail` is a plaintext excerpt of your conversation and may contain secrets, tokens, or other sensitive data. Vault files are written owner-only (`0o600`) under `~/.claude/compact-controller/vault/` and must never be committed to or synced from a public repo.

## Notes

- `input_tokens` reflects the full context-window size for a turn (fresh + cache-read + cache-created tokens), read from the transcript — not an incremental delta.
- stdin parsing strips a leading UTF-8 BOM and normalizes CRLF, so the hooks work when fed JSON through Windows PowerShell pipes as well as POSIX shells.

## Requirements

- Claude Code (with hook support)
- Node.js (ships with Claude Code) — no external packages required

## License

MIT

## Connect

- Discord: [discord.gg/lxvelabs](https://discord.gg/lxvelabs) -- questions, help, or to talk through this project
- GitHub: [@LxveAce](https://github.com/LxveAce)
- Email: LxveLabs@proton.me (business) · lxveace@proton.me (direct)
- Website: [lxvelabs.com](https://lxvelabs.com) · personal: [lxveace.com](https://lxveace.com)
