#!/usr/bin/env node

// Shows current state of the compact controller: token tracking and vault backups.

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR = path.join(os.homedir(), '.claude', 'compact-controller');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const VAULT_DIR = path.join(STATE_DIR, 'vault');

console.log('=== Compact Controller Status ===\n');

// Current state
try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    console.log(`Session:         ${state.session_id || 'none'}`);
    console.log(`Context tokens:  ${(state.input_tokens || 0).toLocaleString()}`);
    console.log(`Output tokens:   ${(state.output_tokens || 0).toLocaleString()}`);
    console.log(`Turns:           ${state.turn_count || 0}`);
    console.log(`Last stop:       ${state.last_stop_reason || 'n/a'}`);
    console.log(`Vaults created:  ${state.vault_count || 0}`);
} catch {
    console.log('No state file found. Controller has not run yet.');
}

// Vault files
console.log('\n=== Vault Backups ===\n');
try {
    const files = fs.readdirSync(VAULT_DIR)
        .filter(f => f.startsWith('vault-') && f.endsWith('.json'))
        .sort()
        .reverse();

    if (files.length === 0) {
        console.log('No vault backups yet.');
    } else {
        for (const f of files) {
            try {
                const vault = JSON.parse(fs.readFileSync(path.join(VAULT_DIR, f), 'utf8'));
                const tokens = (vault.context_tokens || 0).toLocaleString();
                console.log(`  ${vault.timestamp}  |  ${vault.turn_count} turns  |  ~${tokens} tokens`);
            } catch {
                console.log(`  ${f}  |  [error reading]`);
            }
        }
    }
} catch {
    console.log('Vault directory not found.');
}
