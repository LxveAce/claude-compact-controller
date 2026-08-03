'use strict';

// Regressions from a verify-first adversarial audit. Each installer/hook is spawned as a real child
// process with an isolated HOME/USERPROFILE (never touching the user's real ~/.claude), and lib/shared
// is exercised directly. Covers: install never wiping non-hook config on a bad settings.json; install
// non-array coercion; install idempotency across a moved install location; uninstall not removing an
// unrelated hook via a loose substring; uninstall preserving a sibling hook under the same matcher;
// uninstall honestly failing on a corrupt file; the pre/post-compact hooks surfacing (not swallowing)
// a vault failure; and the token parser not losing the newest usage on an oversized JSONL line.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const shared = require('../lib/shared');

function makeHome() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-audit-'));
}
function settingsFile(home) {
    return path.join(home, '.claude', 'settings.json');
}
function writeSettings(home, obj) {
    fs.mkdirSync(path.dirname(settingsFile(home)), { recursive: true });
    fs.writeFileSync(settingsFile(home), typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
}
function readSettingsRaw(home) {
    return fs.readFileSync(settingsFile(home), 'utf8');
}
function run(script, home, extraEnv = {}, input) {
    return spawnSync(process.execPath, [path.join(REPO, script)], {
        cwd: REPO,
        encoding: 'utf8',
        input,
        env: { ...process.env, HOME: home, USERPROFILE: home, ...extraEnv }
    });
}
function allCommands(settings, event) {
    const list = (settings.hooks && settings.hooks[event]) || [];
    const out = [];
    for (const h of list) {
        if (typeof h.command === 'string') out.push(h.command);
        if (Array.isArray(h.hooks)) for (const hh of h.hooks) if (typeof hh.command === 'string') out.push(hh.command);
    }
    return out;
}
function countOwned(settings, event) {
    return allCommands(settings, event)
        .filter(c => c.replace(/\\/g, '/').match(/compact-controller\/hooks\/(stop-hook|pre-compact|post-compact)\.js/))
        .length;
}
function cleanup(home) {
    fs.rmSync(home, { recursive: true, force: true });
}


// --- install.js -------------------------------------------------------------
test('install ABORTS on an unparseable settings.json and never overwrites it (HIGH)', () => {
    const home = makeHome();
    try {
        const bad = '{ "permissions": { "allow": ["Bash"] }, }'; // trailing comma -> invalid JSON
        writeSettings(home, bad);
        const r = run('install.js', home);
        assert.notStrictEqual(r.status, 0, 'install must exit non-zero on a corrupt settings file');
        assert.strictEqual(readSettingsRaw(home), bad, 'the corrupt file must be left byte-for-byte intact');
        assert.ok(fs.existsSync(settingsFile(home) + '.bak'), 'a .bak copy should be written');
        assert.match(r.stderr, /not valid JSON/i);
    } finally {
        cleanup(home);
    }
});

test('install coerces a non-array hooks[event] instead of crashing (LOW)', () => {
    const home = makeHome();
    try {
        // A hand-edit dropped the array wrapper around the Stop hooks.
        writeSettings(home, { hooks: { Stop: { matcher: '', hooks: [] } } });
        const r = run('install.js', home);
        assert.strictEqual(r.status, 0, r.stderr);
        const settings = JSON.parse(readSettingsRaw(home));
        assert.ok(Array.isArray(settings.hooks.Stop));
        assert.strictEqual(countOwned(settings, 'Stop'), 1);
    } finally {
        cleanup(home);
    }
});

test('install is idempotent across a MOVED install location (MED)', () => {
    const home = makeHome();
    const locA = path.join(makeHome(), 'claude-compact-controller');
    const locB = path.join(makeHome(), 'claude-compact-controller');
    try {
        run('install.js', home, { CLAUDE_COMPACT_CONTROLLER_HOME: locA });
        run('install.js', home, { CLAUDE_COMPACT_CONTROLLER_HOME: locB });
        const settings = JSON.parse(readSettingsRaw(home));
        for (const event of ['Stop', 'PreCompact', 'SessionStart']) {
            assert.strictEqual(countOwned(settings, event), 1, `${event} must not be duplicated across locations`);
            // The surviving entry was refreshed to the new location, not left pointing at the old one.
            const cmds = allCommands(settings, event).join('\n').replace(/\\/g, '/');
            assert.ok(cmds.includes(locB.replace(/\\/g, '/')), `${event} command should point at the current location`);
        }
    } finally {
        cleanup(home);
        cleanup(path.dirname(locA));
        cleanup(path.dirname(locB));
    }
});


// --- uninstall.js -----------------------------------------------------------
test('uninstall does NOT remove an unrelated hook that merely mentions compact-controller (MED)', () => {
    const home = makeHome();
    try {
        run('install.js', home);
        // A user's own hook that reads our vault dir — contains "compact-controller" but is NOT ours.
        const settings = JSON.parse(readSettingsRaw(home));
        settings.hooks.SessionStart.push({
            matcher: 'compact',
            hooks: [{ type: 'command', command: 'node /home/me/scripts/show-vault.js ~/.claude/compact-controller/vault/latest.json' }]
        });
        writeSettings(home, settings);

        const r = run('uninstall.js', home);
        assert.strictEqual(r.status, 0, r.stderr);
        const after = JSON.parse(readSettingsRaw(home));
        const cmds = allCommands(after, 'SessionStart').join('\n');
        assert.ok(cmds.includes('show-vault.js'), 'the unrelated vault-reading hook must survive uninstall');
        assert.strictEqual(countOwned(after, 'SessionStart'), 0, 'our own hook must be removed');
    } finally {
        cleanup(home);
    }
});

test('uninstall removes only OUR sub-hook when bundled with a sibling under one matcher (MED)', () => {
    const home = makeHome();
    try {
        run('install.js', home);
        const settings = JSON.parse(readSettingsRaw(home));
        // Merge a foreign command INTO our Stop entry's hooks[] array (same matcher).
        const stopEntry = settings.hooks.Stop.find(e => Array.isArray(e.hooks)
            && e.hooks.some(h => /compact-controller\/hooks\/stop-hook\.js/.test((h.command || '').replace(/\\/g, '/'))));
        stopEntry.hooks.push({ type: 'command', command: 'node /somewhere/else/other.js' });
        writeSettings(home, settings);

        const r = run('uninstall.js', home);
        assert.strictEqual(r.status, 0, r.stderr);
        const after = JSON.parse(readSettingsRaw(home));
        const cmds = allCommands(after, 'Stop').join('\n');
        assert.ok(cmds.includes('other.js'), 'the sibling hook under the same matcher must survive');
        assert.strictEqual(countOwned(after, 'Stop'), 0, 'our sub-hook must be removed');
    } finally {
        cleanup(home);
    }
});

test('uninstall FAILS honestly (non-zero, no write) on a corrupt settings.json (LOW)', () => {
    const home = makeHome();
    try {
        const bad = '{ "hooks": {}, }'; // invalid JSON but present
        writeSettings(home, bad);
        const r = run('uninstall.js', home);
        assert.notStrictEqual(r.status, 0, 'uninstall must not report success on a corrupt file');
        assert.strictEqual(readSettingsRaw(home), bad, 'the file must be left untouched');
        assert.doesNotMatch(r.stdout, /No settings file found/, 'must not claim the file is absent when it exists');
    } finally {
        cleanup(home);
    }
});

test('uninstall skips a non-array hooks[event] without crashing (LOW)', () => {
    const home = makeHome();
    try {
        writeSettings(home, { hooks: { Stop: { matcher: '' } } }); // object, not array
        const r = run('uninstall.js', home);
        assert.strictEqual(r.status, 0, r.stderr);
    } finally {
        cleanup(home);
    }
});


// --- hooks: silent-failure --------------------------------------------------
test('pre-compact SURFACES a vault-write failure instead of swallowing it (HIGH)', () => {
    const home = makeHome();
    try {
        // Make the vault write fail deterministically: place a FILE where the vault DIRECTORY must be,
        // so writing vault-*.json inside it throws (ENOTDIR).
        const stateDir = path.join(home, '.claude', 'compact-controller');
        fs.mkdirSync(stateDir, { recursive: true });
        fs.writeFileSync(path.join(stateDir, 'vault'), 'i am a file, not a directory');

        const transcript = path.join(home, 't.jsonl');
        fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { usage: {} } }) + '\n');

        const r = run('hooks/pre-compact.js', home, {}, JSON.stringify({ session_id: 's', transcript_path: transcript }));
        assert.strictEqual(r.status, 0, 'the hook must still exit 0 (never block compact)');
        const out = JSON.parse(r.stdout);
        assert.strictEqual(out.continue, true);
        assert.match(out.hookSpecificOutput.additionalContext, /FAILED/, 'the backup failure must be surfaced to the model');
    } finally {
        cleanup(home);
    }
});

test('post-compact reports a fallback pointer (not a false success) when the vault read fails (MED)', () => {
    const home = makeHome();
    try {
        const vaultDir = path.join(home, '.claude', 'compact-controller', 'vault');
        fs.mkdirSync(vaultDir, { recursive: true });
        // A corrupt latest vault file makes JSON.parse throw during the read.
        fs.writeFileSync(path.join(vaultDir, 'vault-2026-01-01.json'), '{ not valid json');

        const r = run('hooks/post-compact.js', home, {}, JSON.stringify({ session_id: 's' }));
        assert.strictEqual(r.status, 0, r.stderr);
        const out = JSON.parse(r.stdout);
        assert.match(out.hookSpecificOutput.additionalContext, /could not be read/i,
            'a read failure must produce a fallback pointer, not empty context');
    } finally {
        cleanup(home);
    }
});


// --- lib/shared.js: token parsing -------------------------------------------
test('readLatestUsageFromTranscript recovers the newest usage on an oversized JSONL line (MED)', () => {
    const home = makeHome();
    try {
        const tp = path.join(home, 'transcript.jsonl');
        const userLine = JSON.stringify({ type: 'user', message: { content: 'hi' } });
        // The newest assistant line embeds a large payload so the line itself exceeds the tail window.
        const assistantLine = JSON.stringify({
            type: 'assistant',
            uuid: 'u1',
            message: {
                usage: { input_tokens: 100, cache_read_input_tokens: 200, cache_creation_input_tokens: 300 },
                stop_reason: 'end_turn'
            },
            _pad: 'x'.repeat(8000)
        });
        fs.writeFileSync(tp, userLine + '\n' + assistantLine + '\n');

        // A 2 KB tail lands entirely inside the ~8 KB final line -> the old code returned null.
        const usage = shared.readLatestUsageFromTranscript(tp, 2048);
        assert.ok(usage, 'usage must not be lost when the newest line exceeds the tail window');
        assert.strictEqual(usage.context_tokens, 600);
        assert.strictEqual(usage.input_tokens, 100);
    } finally {
        cleanup(home);
    }
});

test('cleanupStaleTmp sweeps an OLD orphaned atomic-write temp but keeps a fresh one + real vaults (LOW)', () => {
    const home = makeHome();
    try {
        const dir = path.join(home, 'vault');
        fs.mkdirSync(dir, { recursive: true });
        const stale = path.join(dir, '.vault-old.json.999.111.tmp');   // orphaned by a hard crash
        const fresh = path.join(dir, '.vault-new.json.999.222.tmp');   // a concurrent in-flight write
        const real = path.join(dir, 'vault-2026-08-03T00-00-00-000Z.json');
        fs.writeFileSync(stale, 'x');
        fs.writeFileSync(fresh, 'x');
        fs.writeFileSync(real, '{}');
        const twoHoursAgoSec = Date.now() / 1000 - 7200;
        fs.utimesSync(stale, twoHoursAgoSec, twoHoursAgoSec);

        shared.cleanupStaleTmp(dir);   // default maxAge = 1h

        assert.ok(!fs.existsSync(stale), 'an orphaned temp older than the threshold must be swept');
        assert.ok(fs.existsSync(fresh), 'a fresh (in-flight) temp must never be swept');
        assert.ok(fs.existsSync(real), 'a real vault-*.json must never be touched');
    } finally {
        cleanup(home);
    }
});
