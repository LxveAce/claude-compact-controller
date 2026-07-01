#!/usr/bin/env node

// Installs compact controller hooks into user-level Claude Code settings.
// Appends hooks without overwriting existing ones. Safe to run multiple times.

const fs = require('fs');
const path = require('path');
const os = require('os');

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
        console.error(`Warning: Could not parse ${SETTINGS_PATH}: ${e.message}`);
        console.error('Backing up existing file and starting fresh.');
        fs.copyFileSync(SETTINGS_PATH, SETTINGS_PATH + '.bak');
    }
}

if (!settings.hooks) settings.hooks = {};

function hookCmd(scriptName) {
    return `node "${path.join(HOOKS_DIR, scriptName).replace(/\\/g, '/')}"`;
}

// Path-based ownership check, matching catalyst-ui's isOurHookCommand():
// a command is "ours" if it references our resolved hooks directory
// (normalized to forward slashes). This is an exact-path match rather than
// a loose "compact-controller" substring, so the two installers agree on
// which hooks already exist and never double-install.
const HOOKS_ROOT_NORM = HOOKS_DIR.replace(/\\/g, '/');
function isOurHookCommand(command) {
    return typeof command === 'string'
        && command.replace(/\\/g, '/').includes(HOOKS_ROOT_NORM);
}

// Recognize both the nested shape this installer writes
// ({ hooks: [{ command }] }) and the flat shape catalyst-ui writes
// ({ command }), so an install by either tool is detected by the other.
function entryIsOurs(h) {
    if (isOurHookCommand(h?.command)) return true;
    return Array.isArray(h?.hooks) && h.hooks.some(hh => isOurHookCommand(hh?.command));
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
    if (!settings.hooks[event]) settings.hooks[event] = [];

    const alreadyInstalled = settings.hooks[event].some(entryIsOurs);

    if (alreadyInstalled) {
        console.log(`  ${event}: already installed, skipping`);
    } else {
        settings.hooks[event].push(config);
        console.log(`  ${event}: installed`);
        installed++;
    }
}

fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');

console.log(`\n${installed} hook(s) added to ${SETTINGS_PATH}`);
console.log(`Vault directory: ${VAULT_DIR}`);
console.log('\nRestart Claude Code for hooks to take effect.');
