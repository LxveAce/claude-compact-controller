#!/usr/bin/env node

// Removes compact controller hooks from user-level Claude Code settings.
// Preserves vault data for manual cleanup.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { atomicWriteFileSync } = require('./lib/shared');

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

// Mirror install.js: resolve the install home (env-overridable) and match
// hooks by our resolved hooks-directory path, recognizing both the nested
// shape this tool writes and the flat shape catalyst-ui writes. Fall back to
// the legacy "compact-controller" substring so older installs are still removable.
const INSTALL_HOME = process.env.CLAUDE_COMPACT_CONTROLLER_HOME
    ? path.resolve(process.env.CLAUDE_COMPACT_CONTROLLER_HOME)
    : __dirname;
const HOOKS_ROOT_NORM = path.join(INSTALL_HOME, 'hooks').replace(/\\/g, '/');
const OUR_HOOK_FILES = ['stop-hook.js', 'pre-compact.js', 'post-compact.js'];

// Ownership is the exact resolved hooks path, or (for a legacy/moved install) one of our own hook
// scripts under a compact-controller/hooks/ path. NOT a bare "compact-controller" substring — that
// would also match, and wrongly remove, an unrelated user hook that merely reads our vault directory.
function isOurHookCommand(command) {
    if (typeof command !== 'string') return false;
    const norm = command.replace(/\\/g, '/');
    if (norm.includes(HOOKS_ROOT_NORM)) return true;
    return OUR_HOOK_FILES.some(f => norm.includes(`compact-controller/hooks/${f}`));
}

console.log('=== Claude Compact Controller - Uninstall ===\n');

let settings = {};
try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
} catch (e) {
    if (e.code === 'ENOENT') {
        console.log('No settings file found. Nothing to uninstall.');
        process.exit(0);
    }
    // The file EXISTS but won't parse — do NOT falsely report success while our hooks stay
    // registered. Tell the user the real reason and exit non-zero without writing.
    console.error(`Error: ${SETTINGS_PATH} exists but is not valid JSON: ${e.message}`);
    console.error('Fix the JSON, then re-run uninstall. No changes were made.');
    process.exit(1);
}

if (!settings.hooks) {
    console.log('No hooks configured. Nothing to uninstall.');
    process.exit(0);
}

let removed = 0;
// SessionStart is where the recovery hook now lives; PostCompact is kept so a legacy install (which
// registered under PostCompact) is still cleanly removable. Removal is command-matched, so other tools'
// SessionStart hooks are preserved.
for (const event of ['Stop', 'PreCompact', 'SessionStart', 'PostCompact']) {
    if (!Array.isArray(settings.hooks[event])) continue;   // skip a hand-edited non-array value

    let changed = false;
    settings.hooks[event] = settings.hooks[event]
        .map(h => {
            // Flat shape ({command}) that is ours -> drop the whole entry.
            if (isOurHookCommand(h?.command)) { changed = true; return null; }
            // Nested shape: remove ONLY our sub-hooks, keeping any sibling hooks and the matcher —
            // dropping the whole entry would take an unrelated tool's hook down with ours.
            if (Array.isArray(h?.hooks)) {
                const kept = h.hooks.filter(hh => !isOurHookCommand(hh?.command));
                if (kept.length !== h.hooks.length) { changed = true; h.hooks = kept; }
                return kept.length > 0 ? h : null;   // drop the entry only once it is empty
            }
            return h;
        })
        .filter(h => h !== null);

    if (changed) {
        console.log(`  ${event}: removed`);
        removed++;
    }
    if (settings.hooks[event].length === 0) {
        delete settings.hooks[event];
    }
}

if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
}

atomicWriteFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));

console.log(`\n${removed} hook(s) removed from ${SETTINGS_PATH}`);
console.log(`Vault data preserved in ${path.join(os.homedir(), '.claude', 'compact-controller', 'vault')}`);
console.log('Restart Claude Code for changes to take effect.');
