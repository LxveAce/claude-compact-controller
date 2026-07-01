'use strict';

// Tests for `status.js --json`, the stable machine-readable surface consumed by
// catalyst-ui. Freezes the DATA-CONTRACT shape: schema_version, the state block,
// the vault listing, and vault_count_on_disk. Runs against an isolated HOME so no
// real ~/.claude state is read or written; no hardware, no live Claude Code.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const FIXTURE = path.join(__dirname, 'fixtures', 'transcript-usage.jsonl');

function makeHome() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-status-'));
}
function run(scriptArgs, home) {
    return spawnSync(process.execPath, scriptArgs, {
        cwd: REPO,
        encoding: 'utf8',
        env: { ...process.env, HOME: home, USERPROFILE: home }
    });
}
function statusJson(home) {
    const r = run([path.join(REPO, 'status.js'), '--json'], home);
    assert.strictEqual(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
}
function cleanup(home) {
    fs.rmSync(home, { recursive: true, force: true });
}

test('--json on a cold install: null state, empty vaults, count 0', () => {
    const home = makeHome();
    try {
        const out = statusJson(home);
        assert.strictEqual(out.schema_version, 1);
        assert.strictEqual(out.state, null);
        assert.deepStrictEqual(out.vaults, []);
        assert.strictEqual(out.vault_count_on_disk, 0);
        assert.ok(typeof out.state_dir === 'string' && out.state_dir.length > 0);
        assert.ok(typeof out.vault_dir === 'string' && out.vault_dir.length > 0);
    } finally {
        cleanup(home);
    }
});

test('--json reflects real state + a written vault', () => {
    const home = makeHome();
    try {
        // Create state.json via the Stop hook, then a vault via PreCompact.
        spawnSync(process.execPath, [path.join(REPO, 'hooks', 'stop-hook.js')], {
            input: JSON.stringify({ session_id: 's1', transcript_path: FIXTURE }),
            cwd: REPO, encoding: 'utf8',
            env: { ...process.env, HOME: home, USERPROFILE: home }
        });
        spawnSync(process.execPath, [path.join(REPO, 'hooks', 'pre-compact.js')], {
            input: JSON.stringify({ session_id: 's1', trigger: 'auto', transcript_path: FIXTURE }),
            cwd: REPO, encoding: 'utf8',
            env: { ...process.env, HOME: home, USERPROFILE: home }
        });

        const out = statusJson(home);
        assert.strictEqual(out.schema_version, 1);
        assert.ok(out.state, 'state should be present');
        assert.strictEqual(out.state.input_tokens, 227);
        assert.strictEqual(out.state.session_id, 's1');
        assert.strictEqual(out.vault_count_on_disk, 1);
        assert.strictEqual(out.vaults.length, 1);
        assert.strictEqual(out.vaults[0].error, false);
        assert.ok(out.vaults[0].file.startsWith('vault-') && out.vaults[0].file.endsWith('.json'));
    } finally {
        cleanup(home);
    }
});
