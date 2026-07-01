'use strict';

// Tests for the install/uninstall hook plumbing. Each installer is spawned as a
// real child process with an isolated HOME/USERPROFILE, so it patches a throwaway
// ~/.claude/settings.json and never touches the user's real config. This locks in
// the path-based, catalyst-ui-aligned dedupe: repeated installs must not duplicate
// entries, and uninstall must remove exactly what install added.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const HOOKS_ROOT_NORM = path.join(REPO, 'hooks').replace(/\\/g, '/');

function makeHome() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cc-install-'));
}
function settingsFile(home) {
    return path.join(home, '.claude', 'settings.json');
}
function run(script, home, args = []) {
    return spawnSync(process.execPath, [path.join(REPO, script), ...args], {
        cwd: REPO,
        encoding: 'utf8',
        env: { ...process.env, HOME: home, USERPROFILE: home }
    });
}
function readSettings(home) {
    return JSON.parse(fs.readFileSync(settingsFile(home), 'utf8'));
}
function isOurs(command) {
    return typeof command === 'string'
        && command.replace(/\\/g, '/').includes(HOOKS_ROOT_NORM);
}
// Count hook entries across all shapes that reference our hooks dir.
function countOurs(settings, event) {
    const list = (settings.hooks && settings.hooks[event]) || [];
    let n = 0;
    for (const h of list) {
        if (isOurs(h && h.command)) { n++; continue; }
        if (Array.isArray(h && h.hooks) && h.hooks.some(hh => isOurs(hh && hh.command))) n++;
    }
    return n;
}
function cleanup(home) {
    fs.rmSync(home, { recursive: true, force: true });
}

test('install registers all three hook events', () => {
    const home = makeHome();
    try {
        const r = run('install.js', home);
        assert.strictEqual(r.status, 0, r.stderr);
        const settings = readSettings(home);
        for (const event of ['Stop', 'PreCompact', 'SessionStart']) {
            assert.strictEqual(countOurs(settings, event), 1, `${event} should be installed once`);
        }
    } finally {
        cleanup(home);
    }
});

test('install is idempotent: a second run adds no duplicate entries', () => {
    const home = makeHome();
    try {
        run('install.js', home);
        run('install.js', home);
        const settings = readSettings(home);
        for (const event of ['Stop', 'PreCompact', 'SessionStart']) {
            assert.strictEqual(countOurs(settings, event), 1, `${event} must not be duplicated`);
        }
    } finally {
        cleanup(home);
    }
});

test('install preserves unrelated pre-existing hooks', () => {
    const home = makeHome();
    try {
        fs.mkdirSync(path.dirname(settingsFile(home)), { recursive: true });
        const foreign = {
            hooks: {
                Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'node /somewhere/else/other.js' }] }]
            }
        };
        fs.writeFileSync(settingsFile(home), JSON.stringify(foreign, null, 2));

        const r = run('install.js', home);
        assert.strictEqual(r.status, 0, r.stderr);

        const settings = readSettings(home);
        // Foreign Stop hook survives, ours is added alongside it.
        const stopCmds = settings.hooks.Stop.flatMap(e => (e.hooks || []).map(h => h.command));
        assert.ok(stopCmds.some(c => c.includes('other.js')), 'foreign hook must be preserved');
        assert.strictEqual(countOurs(settings, 'Stop'), 1);
    } finally {
        cleanup(home);
    }
});

test('uninstall removes exactly our hooks and leaves others intact', () => {
    const home = makeHome();
    try {
        fs.mkdirSync(path.dirname(settingsFile(home)), { recursive: true });
        const foreign = {
            hooks: {
                Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'node /somewhere/else/other.js' }] }]
            }
        };
        fs.writeFileSync(settingsFile(home), JSON.stringify(foreign, null, 2));

        run('install.js', home);
        const afterInstall = readSettings(home);
        assert.strictEqual(countOurs(afterInstall, 'Stop'), 1);

        const r = run('uninstall.js', home);
        assert.strictEqual(r.status, 0, r.stderr);

        const afterUninstall = readSettings(home);
        for (const event of ['Stop', 'PreCompact', 'SessionStart']) {
            assert.strictEqual(countOurs(afterUninstall, event), 0, `${event} must be removed`);
        }
        // The foreign Stop hook must still be present.
        const stopCmds = (afterUninstall.hooks && afterUninstall.hooks.Stop || [])
            .flatMap(e => (e.hooks || []).map(h => h.command));
        assert.ok(stopCmds.some(c => c.includes('other.js')), 'foreign hook must survive uninstall');
    } finally {
        cleanup(home);
    }
});
