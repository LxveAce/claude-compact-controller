#!/usr/bin/env node

// Installs compact controller hooks into user-level Claude Code settings.
// Appends hooks without overwriting existing ones. Safe to run multiple times.

const fs = require('fs');
const path = require('path');
const os = require('os');

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const HOOKS_DIR = path.join(__dirname, 'hooks');
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
    PostCompact: {
        matcher: 'auto',
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

    const alreadyInstalled = settings.hooks[event].some(h =>
        h.hooks?.some(hh => hh.command?.includes('compact-controller'))
    );

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
