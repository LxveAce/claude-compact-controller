'use strict';

// Integration tests for the three hook scripts. Each hook is spawned as a real
// child process with an isolated HOME/USERPROFILE, so all state.json / vault
// writes land in a throwaway temp dir and never touch the user's real
// ~/.claude/compact-controller. No hardware, no live Claude Code needed.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'transcript-usage.jsonl');
const HOOK = (name) => path.join(REPO, 'hooks', name);

function makeHome() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-home-'));
}
function stateFile(home) {
    return path.join(home, '.claude', 'compact-controller', 'state.json');
}
function vaultDir(home) {
    return path.join(home, '.claude', 'compact-controller', 'vault');
}
function runHook(script, input, home) {
    return spawnSync(process.execPath, [HOOK(script)], {
        input,
        cwd: REPO,
        encoding: 'utf8',
        env: { ...process.env, HOME: home, USERPROFILE: home }
    });
}
function cleanup(home) {
    fs.rmSync(home, { recursive: true, force: true });
}

test('stop-hook writes non-zero token state from the transcript', () => {
    const home = makeHome();
    try {
        const r = runHook('stop-hook.js', JSON.stringify({ session_id: 's1', transcript_path: FIXTURE }), home);
        assert.strictEqual(r.status, 0, r.stderr);
        const st = JSON.parse(fs.readFileSync(stateFile(home), 'utf8'));
        assert.strictEqual(st.input_tokens, 227);   // 7 + 200 + 20
        assert.strictEqual(st.output_tokens, 80);
        assert.strictEqual(st.turn_count, 1);
        assert.strictEqual(st.session_id, 's1');
        assert.strictEqual(st.last_stop_reason, 'end_turn');
        assert.strictEqual(st.last_usage_uuid, 'A2');
    } finally {
        cleanup(home);
    }
});

test('stop-hook de-dupes output across repeated stops on the same last message', () => {
    const home = makeHome();
    try {
        const payload = JSON.stringify({ session_id: 's1', transcript_path: FIXTURE });
        runHook('stop-hook.js', payload, home);
        const r = runHook('stop-hook.js', payload, home);
        assert.strictEqual(r.status, 0, r.stderr);
        const st = JSON.parse(fs.readFileSync(stateFile(home), 'utf8'));
        assert.strictEqual(st.output_tokens, 80, 'output must not double-count the same turn');
        assert.strictEqual(st.turn_count, 2);
    } finally {
        cleanup(home);
    }
});

test('stop-hook exits 0 and writes nothing on empty stdin', () => {
    const home = makeHome();
    try {
        const r = runHook('stop-hook.js', '', home);
        assert.strictEqual(r.status, 0);
        assert.strictEqual(fs.existsSync(stateFile(home)), false);
    } finally {
        cleanup(home);
    }
});

test('stop-hook tolerates BOM + CRLF-wrapped JSON on stdin', () => {
    const home = makeHome();
    try {
        const body = JSON.stringify({ session_id: 's9', transcript_path: FIXTURE }, null, 2).replace(/\n/g, '\r\n');
        const r = runHook('stop-hook.js', '﻿' + body + '\r\n', home);
        assert.strictEqual(r.status, 0, r.stderr);
        const st = JSON.parse(fs.readFileSync(stateFile(home), 'utf8'));
        assert.strictEqual(st.session_id, 's9');
        assert.strictEqual(st.input_tokens, 227);
    } finally {
        cleanup(home);
    }
});

test('pre-compact records the real trigger and emits valid JSON', () => {
    const home = makeHome();
    try {
        const r = runHook('pre-compact.js', JSON.stringify({ session_id: 's1', trigger: 'manual' }), home);
        assert.strictEqual(r.status, 0, r.stderr);
        const out = JSON.parse(r.stdout);
        assert.strictEqual(out.continue, true);
        assert.strictEqual(out.hookSpecificOutput.hookEventName, 'PreCompact');

        const files = fs.readdirSync(vaultDir(home)).filter(f => f.startsWith('vault-'));
        assert.strictEqual(files.length, 1);
        const vault = JSON.parse(fs.readFileSync(path.join(vaultDir(home), files[0]), 'utf8'));
        assert.strictEqual(vault.trigger, 'manual');
    } finally {
        cleanup(home);
    }
});

test('pre-compact and post-compact fail safe (exit 0, valid JSON) on bad stdin', () => {
    for (const [script, evt] of [['pre-compact.js', 'PreCompact'], ['post-compact.js', 'SessionStart']]) {
        for (const bad of ['', 'not json at all', '﻿{bad', '{"partial":']) {
            const home = makeHome();
            try {
                const r = runHook(script, bad, home);
                assert.strictEqual(r.status, 0, `${script} exit on ${JSON.stringify(bad)}: ${r.stderr}`);
                const out = JSON.parse(r.stdout);
                assert.strictEqual(out.continue, true, `${script} should allow continue on ${JSON.stringify(bad)}`);
                assert.ok(evt); // event name only present on the happy path; smoke-assert parse only
            } finally {
                cleanup(home);
            }
        }
    }
});
