# Claude Compact Controller

Smart auto-compact management for Claude Code. Prevents context loss during compaction by saving vault backups of conversation state and injecting recovery references after the compact runs.

Zero dependencies — just Node.js (which ships with Claude Code) and three small hook scripts.

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

Restart Claude Code after installing for the hooks to take effect.

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
