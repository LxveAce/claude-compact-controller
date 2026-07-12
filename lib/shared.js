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

// Coerce an arbitrary JSON value to a finite number, defaulting to 0.
function toNum(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

// Claude Code's Stop payload does NOT carry token-usage fields, so real usage
// has to be read from the session transcript (JSONL). Each assistant turn is
// logged with a `message.usage` block. This returns the usage of the most
// recent MAIN-CHAIN assistant message (sidechain/sub-agent turns are skipped),
// which is the source of truth for the current context-window size.
//
// Only the tail of the transcript is read (default 256 KB) so the Stop hook
// stays well within its timeout even on very long sessions; the newest
// assistant message always lives at the end of the file.
// Read the last `readSize` bytes of the file, drop a partial first line if we started mid-file,
// and return the usage of the most-recent main-chain assistant message (or null).
function _scanTailForUsage(transcriptPath, fileSize, readSize) {
    const start = Math.max(0, fileSize - readSize);
    const fd = fs.openSync(transcriptPath, 'r');
    let text;
    try {
        const buffer = Buffer.alloc(readSize);
        fs.readSync(fd, buffer, 0, readSize, start);
        text = buffer.toString('utf8');
    } finally {
        fs.closeSync(fd);
    }

    // Drop a partial first line if we started mid-file.
    if (start > 0) {
        const nl = text.indexOf('\n');
        text = nl >= 0 ? text.slice(nl + 1) : '';
    }

    let latest = null;
    for (const line of text.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        let obj;
        try { obj = JSON.parse(s); } catch { continue; }
        if (!obj || obj.isSidechain === true) continue;
        const msg = obj.message;
        const usage = msg && msg.usage;
        if (obj.type !== 'assistant' || !usage || typeof usage !== 'object') continue;

        const input = toNum(usage.input_tokens);
        const cacheRead = toNum(usage.cache_read_input_tokens);
        const cacheCreate = toNum(usage.cache_creation_input_tokens);
        latest = {
            uuid: (obj.uuid != null ? String(obj.uuid) : null),
            input_tokens: input,
            cache_read_input_tokens: cacheRead,
            cache_creation_input_tokens: cacheCreate,
            output_tokens: toNum(usage.output_tokens),
            // Full context-window size for the turn: fresh input + cached
            // (read) + newly cache-created tokens all occupy the window.
            context_tokens: input + cacheRead + cacheCreate,
            stop_reason: (msg.stop_reason != null ? msg.stop_reason : null)
        };
    }
    return latest;
}

function readLatestUsageFromTranscript(transcriptPath, tailBytes = 262144) {
    try {
        if (!transcriptPath || !fs.existsSync(transcriptPath)) return null;
        const stats = fs.statSync(transcriptPath);

        let result = _scanTailForUsage(transcriptPath, stats.size, Math.min(tailBytes, stats.size));

        // If the newest assistant message's own JSONL line is LARGER than the tail window, the whole
        // window is one partial line — dropping it discards the only usage line and returns null,
        // freezing token tracking on the biggest turn. Retry with a larger window (bounded), then the
        // whole file, so the newest turn's usage isn't lost.
        if (result === null && stats.size > tailBytes) {
            const grown = Math.min(stats.size, tailBytes * 8);
            result = _scanTailForUsage(transcriptPath, stats.size, grown);
            if (result === null && grown < stats.size) {
                result = _scanTailForUsage(transcriptPath, stats.size, stats.size);
            }
        }
        return result;
    } catch {
        return null;
    }
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
    readLatestUsageFromTranscript,
    loadConfig,
    saveConfig,
    log
};
