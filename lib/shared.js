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

// Atomic, owner-only write: write to a unique temp file in the same
// directory, fsync, then rename over the target. The rename is atomic on
// POSIX and best-effort on Windows. This prevents catalyst-ui (which reads
// the SAME shared files) from ever observing a torn/partial write.
function atomicWriteFileSync(targetPath, contents) {
    const dir = path.dirname(targetPath);
    const tmp = path.join(
        dir,
        `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`
    );
    try {
        const fd = fs.openSync(tmp, 'w', 0o600);
        try {
            fs.writeSync(fd, contents);
            try { fs.fsyncSync(fd); } catch {}
        } finally {
            fs.closeSync(fd);
        }
        try {
            fs.renameSync(tmp, targetPath);
        } catch (e) {
            // Windows can fail rename if the target exists/locked; fall back
            // to remove-then-rename, then to a direct write as last resort.
            try { fs.unlinkSync(targetPath); } catch {}
            fs.renameSync(tmp, targetPath);
        }
        try { fs.chmodSync(targetPath, 0o600); } catch {}
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch {}
        throw e;
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
                // Strip a leading UTF-8 BOM (﻿), normalize CRLF -> LF,
                // and trim surrounding whitespace. Empty input -> null.
                data = data.replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();
                if (!data) { resolve(null); return; }
                resolve(JSON.parse(data));
            }
            catch { resolve(null); }
        });
        process.stdin.on('error', () => resolve(null));
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
    atomicWriteFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

const CONFIG_FILE = path.join(__dirname, '..', 'config.json');

function loadConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch {
        return {
            vault_max_entries: 10,
            vault_transcript_tail_bytes: 50000,
            log_enabled: false
        };
    }
}

// Atomic config writer, mirroring saveState. Kept in the shared module so
// every writer of config.json uses the same crash-safe, owner-only path.
function saveConfig(config) {
    atomicWriteFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
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
    CONFIG_FILE,
    ensureDirs,
    atomicWriteFileSync,
    readStdin,
    loadState,
    saveState,
    loadConfig,
    saveConfig,
    log
};
