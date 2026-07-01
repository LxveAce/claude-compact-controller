# Data Contract

This document freezes the on-disk contract that Claude Compact Controller writes
and that downstream consumers (notably the `catalyst-ui` Compact panel, vault
sync, and cost service) read. **Treat these shapes as a stable surface: add
fields additively, never rename or repurpose an existing field without bumping
the contract and updating every consumer.**

All paths are under the runtime root:

```
~/.claude/compact-controller/
├── state.json
├── controller.log          # only when log_enabled
└── vault/
    └── vault-<timestamp>.json
```

The repository's `config.json` lives next to the hook scripts (resolved as
`<install-home>/config.json`), not under the runtime root.

---

## 1. `state.json`

Single JSON object. Written atomically (temp file + rename, mode `0o600`) by the
hooks so a concurrent reader never sees a torn write. Consumers must tolerate
missing keys and apply their own defaults.

| Field                  | Type             | Written by      | Meaning |
|------------------------|------------------|-----------------|---------|
| `session_id`           | string \| null   | stop-hook       | Current Claude session id. |
| `input_tokens`         | number           | stop-hook       | Full context-window size for the most recent turn (fresh + cache-read + cache-created tokens), read from the transcript. Not incremental. |
| `output_tokens`        | number           | stop-hook       | Cumulative output tokens for the session, accumulated from the transcript across turns. |
| `turn_count`           | number           | stop-hook       | Number of turns since session start (or since last post-compact reset). |
| `last_stop_reason`     | string \| null   | stop-hook       | `stop_reason` for the last turn (from the Stop payload if present, else the transcript). |
| `last_transcript_path` | string \| null   | stop-hook       | Path to the transcript file for the current session. |
| `last_usage_uuid`      | string \| null   | stop-hook       | uuid of the last assistant message whose output was counted; de-dupes output accumulation. Internal; consumers may ignore. |
| `vault_count`          | number           | pre-compact     | Number of vaults created in this session. |
| `last_vault_file`      | string \| null   | pre-compact     | Absolute path of the most recently written vault file. |

Reset behavior:
- New session (stop-hook sees a changed `session_id`): `input_tokens`,
  `output_tokens`, `turn_count`, `vault_count` reset to `0`, and
  `last_vault_file` / `last_usage_uuid` reset to `null`, so no session-scoped
  field is carried over from the previous session.
- Post-compact: `input_tokens`, `output_tokens`, `turn_count` reset to `0`.

Consumed by catalyst-ui: `session_id`, `input_tokens`, `output_tokens`,
`turn_count` (`src/main/compact-controller.ts`, `cost-service.ts`).

---

## 2. Vault files: `vault/vault-<timestamp>.json`

### Filename pattern

```
vault-<timestamp>.json
```

`<timestamp>` is `new Date().toISOString()` with `:` and `.` replaced by `-`,
e.g. `vault-2026-05-21T14-30-00-000Z.json`. The generated name therefore only
contains characters in `[A-Za-z0-9._-]` and **must continue to match the
consumer-side guard**:

```
/^vault-[A-Za-z0-9._-]+\.json$/
```

(catalyst-ui `cloud-sync.ts` / `cost-service.ts`). Files are lexicographically
sortable by name in chronological order; consumers rely on
`readdir().sort()` giving oldest-first ordering.

### File body

Single JSON object, written atomically (temp + rename, mode `0o600`).

| Field                 | Type   | Meaning |
|-----------------------|--------|---------|
| `timestamp`           | string | ISO-8601 creation time. |
| `session_id`          | string \| null | Session that triggered the vault. |
| `trigger`             | string | PreCompact trigger reported by Claude Code (`"auto"` \| `"manual"`); defaults to `"auto"` (the installed matcher). |
| `context_tokens`      | number | Context-window size (`input_tokens`) at vault time. |
| `output_tokens_total` | number | Cumulative output tokens at vault time. |
| `turn_count`          | number | Turns captured at vault time. |
| `cwd`                 | string | Working directory reported by the hook (may be empty). |
| `transcript_tail`     | string | Tail of the transcript (default last 50 KB). May contain sensitive content. |

Consumed by catalyst-ui: `transcript_tail`, `context_tokens`, `cwd`
(`cloud-sync.ts`); `context_tokens`, `output_tokens_total` (with fallback to
`output_tokens`) (`cost-service.ts`).

> Sensitivity: `transcript_tail` can hold secrets/PII. Vaults are written with
> mode `0o600` and must never be committed to or synced from a public repo.

---

## 3. `config.json`

Resolved as `<install-home>/config.json` (default: the directory containing the
installed scripts; override the install home via the
`CLAUDE_COMPACT_CONTROLLER_HOME` environment variable). Written atomically
(temp + rename, mode `0o600`) by any writer using `saveConfig()`.

| Key                            | Type    | Default | Meaning |
|--------------------------------|---------|---------|---------|
| `vault_max_entries`            | number  | `10`    | Max vault files retained; the newest `vault_max_entries` are kept, older ones pruned. |
| `vault_transcript_tail_bytes`  | number  | `50000` | Bytes of transcript tail captured per vault. |
| `log_enabled`                  | boolean | `false` | Enable debug logging to `controller.log`. |

catalyst-ui reads and writes the same three keys
(`src/main/compact-controller.ts`).

---

## 4. `node status.js --json`

Stable machine-readable surface for tooling. Shape:

```json
{
  "schema_version": 1,
  "state_dir": "<abs>",
  "state_file": "<abs>",
  "vault_dir": "<abs>",
  "state": { /* state.json object, or null if absent */ },
  "vaults": [
    { "file": "vault-….json", "timestamp": "…", "turn_count": 0, "context_tokens": 0, "error": false }
  ],
  "vault_count_on_disk": 0
}
```

`schema_version` is bumped on any breaking change to this object.

---

## Compatibility notes

- **Pruning** keeps exactly `vault_max_entries` newest vault files.
- **Atomic writes**: `state.json`, `config.json`, and each `vault-*.json` are
  written via temp-file + rename with mode `0o600`, matching catalyst-ui's
  temp+rename writes to the same shared files.
- **Install path**: hook commands embed the resolved hooks directory
  (`<install-home>/hooks`). Ownership detection is a path match on that
  directory (not a loose `compact-controller` substring), aligned with
  catalyst-ui's `isOurHookCommand`, so the two installers never double-install.
