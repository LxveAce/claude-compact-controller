'use strict';

// Tests for `doctor.js` — the read-only self-check. Each run is a real child process with an isolated
// HOME/USERPROFILE, so it inspects a throwaway ~/.claude/settings.json and never touches the real config.
// It resolves its hooks dir from this checkout (__dirname), so after a real install into the temp home the
// settings entries point at the same dir doctor checks — a healthy result. Without an install, the three
// hooks are absent, which doctor must report as a critical failure (exit 1).

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');

function makeHome() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-doctor-'));
}
function run(script, home, args = []) {
    return spawnSync(process.execPath, [path.join(REPO, script), ...args], {
        cwd: REPO,
        encoding: 'utf8',
        env: { ...process.env, HOME: home, USERPROFILE: home }
    });
}
function cleanup(home) {
    fs.rmSync(home, { recursive: true, force: true });
}

test('doctor: reports healthy (exit 0) after a real install', () => {
    const home = makeHome();
    try {
        const inst = run('install.js', home);
        assert.equal(inst.status, 0, 'install should succeed');
        const doc = run('doctor.js', home);
        assert.equal(doc.status, 0, `doctor should exit 0 when installed:\n${doc.stdout}\n${doc.stderr}`);
        assert.match(doc.stdout, /installed and healthy|Healthy, with/);
        // every hook is reported installed, no critical FAIL line
        for (const ev of ['Stop', 'PreCompact', 'SessionStart']) {
            assert.match(doc.stdout, new RegExp(`\\[OK  \\] ${ev} hook installed`), `${ev} should be OK`);
        }
        assert.doesNotMatch(doc.stdout, /\[FAIL\]/, 'no critical failures when installed');
    } finally {
        cleanup(home);
    }
});

test('doctor: critical failure (exit 1) when the hooks are not installed', () => {
    const home = makeHome();
    try {
        const doc = run('doctor.js', home); // no install first
        assert.equal(doc.status, 1, 'doctor should exit 1 when not installed');
        assert.match(doc.stdout, /Stop hook installed.*\n.*node install\.js|not found in settings\.json/);
        assert.match(doc.stdout, /will NOT run until fixed/);
    } finally {
        cleanup(home);
    }
});

test('doctor --json: a valid machine surface with the health verdict', () => {
    const home = makeHome();
    try {
        run('install.js', home);
        const doc = run('doctor.js', home, ['--json']);
        assert.equal(doc.status, 0);
        const out = JSON.parse(doc.stdout);
        assert.equal(out.healthy, true);
        assert.equal(out.critical_failures, 0);
        assert.ok(Array.isArray(out.checks) && out.checks.length > 0);
        assert.ok(out.install_home && out.hooks_dir && out.settings_path);
        // json mode emits ONLY json (no human banner leaking in)
        assert.doesNotMatch(doc.stdout, /=== Compact Controller Doctor ===/);
    } finally {
        cleanup(home);
    }
});
