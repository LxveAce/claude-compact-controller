const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR = path.join(os.homedir(), '.claude', 'compact-controller');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const VAULT_DIR = path.join(STATE_DIR, 'vault');

function ensureDirs() {
    for (const dir of [STATE_DIR, VAULT_DIR]) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    }
}

function readStdin() {
    return new Promise((resolve) => {
        let data = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('readable', () => {
            let chunk;
            while ((chunk = process.stdin.read()) !== null) {
                data += chunk;
            }
        });
        process.stdin.on('end', () => {
            try {
                data = data.replace(/^﻿/, '').trim();
                resolve(JSON.parse(data));
            }
            catch { resolve(null); }
        });
    });
}

function loadState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {
        return {
            session_id: null,
            input_tokens: 0,
            output_tokens: 0,
            turn_count: 0,
            last_stop_reason: null,
            last_transcript_path: null,
            vault_count: 0,
            last_vault_file: null
        };
    }
}

function saveState(state) {
    ensureDirs();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function loadConfig() {
    const configPath = path.join(__dirname, '..', 'config.json');
    try {
        return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
        return {
            vault_max_entries: 10,
            vault_transcript_tail_bytes: 50000,
            log_enabled: false
        };
    }
}

function log(msg) {
    const config = loadConfig();
    if (!config.log_enabled) return;
    const logFile = path.join(STATE_DIR, 'controller.log');
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(logFile, line, 'utf8');
}

module.exports = {
    STATE_DIR,
    STATE_FILE,
    VAULT_DIR,
    ensureDirs,
    readStdin,
    loadState,
    saveState,
    loadConfig,
    log
};
