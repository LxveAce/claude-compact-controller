#!/usr/bin/env node

// Removes compact controller hooks from user-level Claude Code settings.
// Preserves vault data for manual cleanup.

const fs = require('fs');
const path = require('path');
const os = require('os');

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

// Mirror install.js: resolve the install home (env-overridable) and match
// hooks by our resolved hooks-directory path, recognizing both the nested
// shape this tool writes and the flat shape catalyst-ui writes. Fall back to
// the legacy "compact-controller" substring so older installs are still removable.
const INSTALL_HOME = process.env.CLAUDE_COMPACT_CONTROLLER_HOME
    ? path.resolve(process.env.CLAUDE_COMPACT_CONTROLLER_HOME)
    : __dirname;
const HOOKS_ROOT_NORM = path.join(INSTALL_HOME, 'hooks').replace(/\\/g, '/');

function isOurHookCommand(command) {
    if (typeof command !== 'string') return false;
    const norm = command.replace(/\\/g, '/');
    return norm.includes(HOOKS_ROOT_NORM) || norm.includes('compact-controller');
}

function entryIsOurs(h) {
    if (isOurHookCommand(h?.command)) return true;
    return Array.isArray(h?.hooks) && h.hooks.some(hh => isOurHookCommand(hh?.command));
}

console.log('=== Claude Compact Controller - Uninstall ===\n');

let settings = {};
try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
} catch {
    console.log('No settings file found. Nothing to uninstall.');
    process.exit(0);
}

if (!settings.hooks) {
    console.log('No hooks configured. Nothing to uninstall.');
    process.exit(0);
}

let removed = 0;
for (const event of ['Stop', 'PreCompact', 'PostCompact']) {
    if (!settings.hooks[event]) continue;

    const before = settings.hooks[event].length;
    settings.hooks[event] = settings.hooks[event].filter(h => !entryIsOurs(h));
    const after = settings.hooks[event].length;

    if (before > after) {
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

fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');

console.log(`\n${removed} hook(s) removed from ${SETTINGS_PATH}`);
console.log(`Vault data preserved in ${path.join(os.homedir(), '.claude', 'compact-controller', 'vault')}`);
console.log('Restart Claude Code for changes to take effect.');
