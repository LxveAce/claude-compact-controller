#!/usr/bin/env node

// Shows current state of the compact controller: token tracking and vault backups.
// Pass --json for a stable, machine-readable surface (consumed by catalyst-ui).

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR = path.join(os.homedir(), '.claude', 'compact-controller');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const VAULT_DIR = path.join(STATE_DIR, 'vault');

const jsonMode = process.argv.slice(2).includes('--json');

function readState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {
        return null;
    }
}

function readVaults() {
    let files;
    try {
        files = fs.readdirSync(VAULT_DIR)
            .filter(f => f.startsWith('vault-') && f.endsWith('.json'))
            .sort()
            .reverse();
    } catch {
        return null;
    }
    return files.map(f => {
        try {
            const vault = JSON.parse(fs.readFileSync(path.join(VAULT_DIR, f), 'utf8'));
            return {
                file: f,
                timestamp: vault.timestamp || null,
                turn_count: vault.turn_count || 0,
                context_tokens: vault.context_tokens || 0,
                error: false
            };
        } catch {
            return { file: f, timestamp: null, turn_count: 0, context_tokens: 0, error: true };
        }
    });
}

if (jsonMode) {
    const state = readState();
    const vaults = readVaults();
    const out = {
        schema_version: 1,
        state_dir: STATE_DIR,
        state_file: STATE_FILE,
        vault_dir: VAULT_DIR,
        state: state,                          // null if no state file yet
        vaults: vaults === null ? [] : vaults, // [] if dir missing or empty
        vault_count_on_disk: vaults === null ? 0 : vaults.length
    };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    process.exit(0);
}

console.log('=== Compact Controller Status ===\n');

// Current state
const state = readState();
if (state) {
    console.log(`Session:         ${state.session_id || 'none'}`);
    console.log(`Context tokens:  ${(state.input_tokens || 0).toLocaleString()}`);
    console.log(`Output tokens:   ${(state.output_tokens || 0).toLocaleString()}`);
    console.log(`Turns:           ${state.turn_count || 0}`);
    console.log(`Last stop:       ${state.last_stop_reason || 'n/a'}`);
    console.log(`Vaults created:  ${state.vault_count || 0}`);
} else {
    console.log('No state file found. Controller has not run yet.');
}

// Vault files
console.log('\n=== Vault Backups ===\n');
const vaults = readVaults();
if (vaults === null) {
    console.log('Vault directory not found.');
} else if (vaults.length === 0) {
    console.log('No vault backups yet.');
} else {
    for (const v of vaults) {
        if (v.error) {
            console.log(`  ${v.file}  |  [error reading]`);
        } else {
            const tokens = (v.context_tokens || 0).toLocaleString();
            console.log(`  ${v.timestamp}  |  ${v.turn_count} turns  |  ~${tokens} tokens`);
        }
    }
}
