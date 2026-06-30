# Claude Compact Controller

> Provided **as is**, without warranty; you use it at your own risk. See [DISCLAIMER.md](DISCLAIMER.md).

Smart auto-compact management for Claude Code. Prevents context loss during compaction by saving vault backups of conversation state and injecting recovery references after the compact runs.

Zero dependencies — just Node.js (which ships with Claude Code) and three small hook scripts.

<!-- STATUS-ROADMAP:START -->
## Status & Roadmap

**Status:** Installable, crash-safe, zero-dependency hook bundle; the install/uninstall/status flow and fail-safe error handling are working. Two headline behaviors (Stop-hook token fields and PostCompact recovery-pointer injection) are still being verified against the live Claude Code hook contract. Health: actively under development.

**In progress / known issues:**
- Verifying against the live Claude Code hook contract whether the Stop hook receives token fields and whether PostCompact honors injected recovery context — token tracking and the post-compact pointer depend on these.
- Reconciling the canonical install path with the downstream catalyst-ui consumer so both tools recognize the same hook location.
- Windows stdin-handling reliability fix in progress (tracked upstream as anthropics/claude-code#46601).

**Roadmap:**
- Publish a versioned data-contract doc for `state.json`, `vault-*.json` naming, and config keys.
- Add machine-readable `node status.js --json` output.
- Add a `doctor` / self-check command (resolved install path, hooks present in settings, live-contract findings, path-mismatch detection).
- Make the install path configurable (env var / setting) so non-default clone locations stay recognizable.
- Cut a real tagged release so installs are pinnable.
- Add atomic writes and restrictive permissions for shared state/config files, plus documented handling of sensitive vault contents.
- Add a minimal dependency-free smoke harness and CI across Linux and Windows runners.
<!-- STATUS-ROADMAP:END -->

## Problem

When Claude Code auto-compacts, it summarizes the conversation to free up context-window space. That summary can drop details Claude was relying on — files it edited, decisions it made, or multi-step operations still in progress. The Compact Controller wraps the compact lifecycle so a full backup is captured first and a pointer back to it is handed to Claude afterward.

## How It Works

Three hooks work together across the auto-compact lifecycle:

1. **Stop hook** — fires after every Claude response. Tracks the current context-window size (`input_tokens`), accumulates output tokens, and increments a turn counter in a persistent state file. Counters reset automatically when a new session starts.

2. **PreCompact hook** (matcher `auto`) — fires right before auto-compaction. Reads the tail of the conversation transcript and writes it to a timestamped vault file, then prunes old vaults beyond the retention limit. Injects an `additionalContext` message so Claude knows a backup was saved.

3. **PostCompact hook** (matcher `auto`) — fires right after compaction finishes. Injects a message pointing Claude to the most recent vault file so it can recover any lost context, then resets the token/turn counters for fresh post-compact tracking.

```
Normal operation:        Stop hook tracks tokens each turn
                              |
Auto-compact triggers:   PreCompact saves vault backup + prunes old vaults
                              |
Compact runs:            Conversation is summarized
                              |
Post-compact:            PostCompact injects vault reference, resets counters
                              |
Claude continues:        Can read the vault file if context was lost
```

Hooks are designed to fail safe — any error is swallowed so the controller can never crash Claude Code or block a compaction.

## Install

```bash
cd claude-compact-controller
node install.js
```

This appends three hooks to your user-level `~/.claude/settings.json` (Stop, PreCompact `auto`, PostCompact `auto`) and creates the runtime directories. It is safe to run multiple times — already-installed hooks are detected and skipped, and existing unrelated hooks are preserved. If your settings file exists but can't be parsed, it is backed up to `settings.json.bak` before being rewritten.

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
│   └── post-compact.js             # Vault reference injection (PostCompact event)
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

Each vault file is JSON:

```json
{
    "timestamp": "2026-05-21T14:30:00.000Z",
    "session_id": "abc123",
    "trigger": "auto-compact",
    "context_tokens": 185000,
    "output_tokens_total": 42000,
    "turn_count": 47,
    "cwd": "/path/to/project",
    "transcript_tail": "... last ~50KB of conversation ..."
}
```

## Notes

- `input_tokens` reflects the full context-window size reported for a turn, not an incremental delta.
- stdin parsing strips a leading UTF-8 BOM, so the hooks work when fed JSON through Windows PowerShell pipes as well as POSIX shells.

## Requirements

- Claude Code (with hook support)
- Node.js (ships with Claude Code) — no external packages required

## License

MIT

## Connect

- Discord: [discord.gg/lxveace](https://discord.gg/lxveace) -- questions, help, or to talk through this project
- GitHub: [@LxveAce](https://github.com/LxveAce)
- Website: [lxveace.com](https://lxveace.com)
