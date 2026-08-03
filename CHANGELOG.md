# Changelog

All notable changes to Claude Compact Controller are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/); versioning: [SemVer](https://semver.org/).

## [Unreleased]

### Fixed
- **Orphaned atomic-write temp files could accumulate.** A hard crash/kill between the temp write and the
  atomic rename left a `.<name>.<pid>.<ms>.tmp` behind (a *caught* failure already removed its own temp).
  Selection paths filter to `vault-*.json` so they were harmless, but they piled up on disk. The pre-compact
  vault write now sweeps stale temps via a new `cleanupStaleTmp` helper — only ones older than an hour, so a
  concurrent in-flight write's fresh temp is never touched.

## [1.0.1] - 2026-07-01

### Fixed
- **Token tracking read 0/0 (the headline v1.0.0 bug).** Usage is now derived from the session transcript
  JSONL — the Stop hook payload carries no token fields — so context/output tokens and the turn counter are
  real values, not zeros.
- **The post-compact recovery pointer never reached the model.** It was injected on the `PostCompact` event,
  which has no decision control and cannot return `additionalContext` (verified against the Claude Code hook
  docs). It now uses the `SessionStart` `compact` hook, which fires after auto/manual compaction *and* supports
  `additionalContext`, so the pointer to the pre-compact vault actually lands.
- Session-scoped state resets consistently; the real PreCompact `trigger` (auto/manual) is recorded.

### Added
- A dependency-free test suite (`npm test`) covering the hooks, the token parser, install/uninstall path-dedupe,
  and the `status.js --json` contract; plus push/PR CI (Ubuntu + Windows).
- Canonical DISCLAIMER + acceptable-use terms, linked from the README.

### Changed
- README corrected to shipped reality (+ a vault-privacy note); FORWARD-PLAN refreshed.

## [1.0.0] - 2026-06-27
- Initial release: installable, crash-safe, zero-dependency auto-compact hook bundle (Stop / PreCompact /
  post-compact) with vault backups and configurable install path. (Superseded by 1.0.1, which fixes the
  token-tracking and recovery-pointer-injection paths.)

[1.0.1]: https://github.com/LxveAce/claude-compact-controller/releases/tag/v1.0.1
[1.0.0]: https://github.com/LxveAce/claude-compact-controller/releases/tag/v1.0.0
