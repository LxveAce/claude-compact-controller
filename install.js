#!/usr/bin/env node

// Installs compact controller hooks into user-level Claude Code settings.
// Appends hooks without overwriting existing ones. Safe to run multiple times.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { atomicWriteFileSync } = require('./lib/shared');

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

// Install root is configurable so both the canonical ~/claude-compact-controller
// location and arbitrary clones are recognizable. Override with
// CLAUDE_COMPACT_CONTROLLER_HOME; otherwise default to this script's directory.
const INSTALL_HOME = process.env.CLAUDE_COMPACT_CONTROLLER_HOME
    ? path.resolve(process.env.CLAUDE_COMPACT_CONTROLLER_HOME)
    : __dirname;
const HOOKS_DIR = path.join(INSTALL_HOME, 'hooks');
const STATE_DIR = path.join(os.homedir(), '.claude', 'compact-controller');
const VAULT_DIR = path.join(STATE_DIR, 'vault');

console.log('=== Claude Compact Controller - Install ===\n');

// Ensure runtime directories
for (const dir of [STATE_DIR, VAULT_DIR]) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`Created: ${dir}`);
    }
}

// Load existing settings
let settings = {};
try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
} catch (e) {
    if (e.code !== 'ENOENT') {
        // The file EXISTS but won't parse (a hand-edit: trailing comma, // comment, unquoted key).
        // Do NOT continue with an empty object — writing our hooks onto {} and saving would ERASE the
        // user's permissions/env/model and every other key. Back it up, explain, and abort.
        try { fs.copyFileSync(SETTINGS_PATH, SETTINGS_PATH + '.bak'); } catch {}
        console.error(`Error: ${SETTINGS_PATH} exists but is not valid JSON: ${e.message}`);
        console.error(`A copy was saved to ${SETTINGS_PATH}.bak. Fix the JSON, then re-run install.`);
        console.error('Aborting so your existing settings are not overwritten.');
        process.exit(1);
    }
    // ENOENT: no settings file yet — a clean first install, start from {}.
}

// Coerce a hand-edited non-object hooks value so the per-event logic below can't crash.
if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    settings.hooks = {};
}

function hookCmd(scriptName) {
    return `node "${path.join(HOOKS_DIR, scriptName).replace(/\\/g, '/')}"`;
}

// Path-based ownership check, matching catalyst-ui's isOurHookCommand():
// a command is "ours" if it references our resolved hooks directory
// (normalized to forward slashes). This is an exact-path match rather than
// a loose "compact-controller" substring, so the two installers agree on
// which hooks already exist and never double-install.
const HOOKS_ROOT_NORM = HOOKS_DIR.replace(/\\/g, '/');
// The three hook scripts this tool installs. Used for a location-independent ownership check so an
// install from a moved/re-cloned checkout still recognizes a prior install (and refreshes it) instead
// of appending a duplicate entry that points at the old, now-stale path.
const OUR_HOOK_FILES = ['stop-hook.js', 'pre-compact.js', 'post-compact.js'];
function isOurHookCommand(command) {
    if (typeof command !== 'string') return false;
    const norm = command.replace(/\\/g, '/');
    if (norm.includes(HOOKS_ROOT_NORM)) return true;
    return OUR_HOOK_FILES.some(f => norm.includes(`compact-controller/hooks/${f}`));
}

// Recognize both the nested shape this installer writes
// ({ hooks: [{ command }] }) and the flat shape catalyst-ui writes
// ({ command }), so an install by either tool is detected by the other.
function entryIsOurs(h) {
    if (isOurHookCommand(h?.command)) return true;
    return Array.isArray(h?.hooks) && h.hooks.some(hh => isOurHookCommand(hh?.command));
}

// Rewrite any owned command in an event's entries to the freshly-resolved path, so an install run
// from a moved/re-cloned checkout self-heals a stale path instead of leaving a broken hook behind.
function refreshOwnedCommands(entries, freshCommand) {
    for (const h of entries) {
        if (isOurHookCommand(h?.command)) { h.command = freshCommand; continue; }
        if (Array.isArray(h?.hooks)) {
            for (const hh of h.hooks) {
                if (isOurHookCommand(hh?.command)) hh.command = freshCommand;
            }
        }
    }
}

const hookConfigs = {
    Stop: {
        matcher: '',
        hooks: [{
            type: 'command',
            command: hookCmd('stop-hook.js'),
            timeout: 5
        }]
    },
    PreCompact: {
        matcher: 'auto',
        hooks: [{
            type: 'command',
            command: hookCmd('pre-compact.js'),
            timeout: 10
        }]
    },
    // The post-compact recovery pointer is injected via additionalContext, which the PostCompact event
    // does NOT support (it has no decision control — side-effects only, per the Claude Code hook contract).
    // SessionStart with matcher "compact" fires after auto OR manual compaction AND supports
    // additionalContext, so the recovery pointer actually reaches the model. (Runs hooks/post-compact.js.)
    SessionStart: {
        matcher: 'compact',
        hooks: [{
            type: 'command',
            command: hookCmd('post-compact.js'),
            timeout: 10
        }]
    }
};

let installed = 0;
for (const [event, config] of Object.entries(hookConfigs)) {
    // Coerce a hand-edited non-array event value so .some()/.push() below can't crash.
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];

    const alreadyInstalled = settings.hooks[event].some(entryIsOurs);

    if (alreadyInstalled) {
        // Refresh the path in case this install moved (self-heal) rather than appending a duplicate.
        refreshOwnedCommands(settings.hooks[event], config.hooks[0].command);
        console.log(`  ${event}: already installed (path refreshed)`);
    } else {
        settings.hooks[event].push(config);
        console.log(`  ${event}: installed`);
        installed++;
    }
}

atomicWriteFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));

console.log(`\n${installed} hook(s) added to ${SETTINGS_PATH}`);
console.log(`Vault directory: ${VAULT_DIR}`);
console.log('\nRestart Claude Code for hooks to take effect.');
