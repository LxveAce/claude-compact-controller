#!/usr/bin/env node

// doctor.js — self-check for the compact controller. Read-only: it never writes settings, hooks, or
// state. Verifies the resolved install path, that all three hooks are present in Claude Code's settings
// with the right matchers, that the settings entries point at THIS checkout (path-mismatch detection),
// that the hook scripts exist, and that the runtime dirs + config are healthy. Exits 0 when every
// critical check passes, 1 otherwise, so it's usable in scripts/CI. Pass --json for a machine surface.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { CONFIG_FILE } = require('./lib/shared');

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
// Install root resolves exactly as install.js does, so doctor checks the same location a re-install would.
const INSTALL_HOME = process.env.CLAUDE_COMPACT_CONTROLLER_HOME
    ? path.resolve(process.env.CLAUDE_COMPACT_CONTROLLER_HOME)
    : __dirname;
const HOOKS_DIR = path.join(INSTALL_HOME, 'hooks');
const HOOKS_ROOT_NORM = HOOKS_DIR.replace(/\\/g, '/');
const STATE_DIR = path.join(os.homedir(), '.claude', 'compact-controller');
const VAULT_DIR = path.join(STATE_DIR, 'vault');

const jsonMode = process.argv.slice(2).includes('--json');

// The three hooks this tool installs — event, required matcher, and the script each runs. The source of
// truth for the definitions is install.js; mirrored here for the read-only check (the file names + events
// are the tool's stable contract).
const HOOKS = [
    { event: 'Stop', matcher: '', file: 'stop-hook.js' },
    { event: 'PreCompact', matcher: 'auto', file: 'pre-compact.js' },
    { event: 'SessionStart', matcher: 'compact', file: 'post-compact.js' },
];
const OUR_HOOK_FILES = HOOKS.map((h) => h.file);

// Path-based ownership check, matching install.js / catalyst-ui: a command is "ours" if it references our
// resolved hooks dir, or any of our hook files under a compact-controller/hooks/ path.
function isOurHookCommand(command) {
    if (typeof command !== 'string') return false;
    const norm = command.replace(/\\/g, '/');
    if (norm.includes(HOOKS_ROOT_NORM)) return true;
    return OUR_HOOK_FILES.some((f) => norm.includes(`compact-controller/hooks/${f}`));
}

// The event entry (nested `{hooks:[{command}]}` or flat `{command}`) that owns our command, or null.
function findOwnedEntry(entries) {
    if (!Array.isArray(entries)) return null;
    for (const h of entries) {
        if (isOurHookCommand(h && h.command)) return h;
        if (Array.isArray(h && h.hooks) && h.hooks.some((hh) => isOurHookCommand(hh && hh.command))) return h;
    }
    return null;
}

// The owned command string within an event's entries, or '' if none.
function ownedCommand(entries) {
    if (!Array.isArray(entries)) return '';
    for (const h of entries) {
        if (isOurHookCommand(h && h.command)) return h.command;
        if (Array.isArray(h && h.hooks)) {
            for (const hh of h.hooks) if (isOurHookCommand(hh && hh.command)) return hh.command;
        }
    }
    return '';
}

const checks = [];
// level: 'critical' (broken → controller won't run) or 'warn' (works but degraded / stale).
function add(level, name, ok, detail, fix) { checks.push({ level, name, ok, detail: detail || '', fix: fix || '' }); }

// 1. settings.json
let settings = null;
try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    add('critical', 'settings.json readable', true, SETTINGS_PATH);
} catch (e) {
    add('critical', 'settings.json readable', false,
        e.code === 'ENOENT' ? 'not found' : `invalid JSON: ${e.message}`,
        'run `node install.js` (creates or updates it)');
}
const hooks = settings && settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
    ? settings.hooks : {};

// 2. each hook present, matcher correct, path points at THIS checkout
for (const h of HOOKS) {
    const entry = findOwnedEntry(hooks[h.event]);
    if (!entry) {
        add('critical', `${h.event} hook installed`, false, 'not found in settings.json',
            'run `node install.js`, then restart Claude Code');
        continue;
    }
    add('critical', `${h.event} hook installed`, true, `matcher="${entry.matcher || ''}"`);
    if ((entry.matcher || '') !== h.matcher) {
        add('warn', `${h.event} matcher`, false, `expected "${h.matcher}", found "${entry.matcher || ''}"`,
            'run `node install.js` to correct the matcher');
    }
    const cmd = ownedCommand(hooks[h.event]).replace(/\\/g, '/');
    if (cmd && !cmd.includes(HOOKS_ROOT_NORM)) {
        add('warn', `${h.event} path`, false, 'settings points at a different/older checkout',
            're-run `node install.js` from THIS directory (it self-heals the path)');
    }
}

// 3. hook scripts exist + readable in this checkout
for (const h of HOOKS) {
    const p = path.join(HOOKS_DIR, h.file);
    try { fs.accessSync(p, fs.constants.R_OK); add('critical', `hook script ${h.file}`, true, p); }
    catch { add('critical', `hook script ${h.file}`, false, `missing at ${p}`, 're-clone or repair this checkout'); }
}

// 4. runtime dirs exist + writable
for (const [label, dir] of [['state dir', STATE_DIR], ['vault dir', VAULT_DIR]]) {
    if (!fs.existsSync(dir)) {
        add('warn', `${label} exists`, false, `missing: ${dir}`, 'run `node install.js` (creates it)');
        continue;
    }
    try { fs.accessSync(dir, fs.constants.W_OK); add('warn', `${label} writable`, true, dir); }
    catch { add('warn', `${label} writable`, false, `not writable: ${dir}`, 'fix the directory permissions'); }
}

// 5. config.json is absent (defaults used) or valid — a present-but-corrupt file is a real problem
try {
    fs.readFileSync(CONFIG_FILE, 'utf8'); // present
    try { JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); add('warn', 'config.json valid', true, CONFIG_FILE); }
    catch (e) { add('warn', 'config.json valid', false, `invalid JSON: ${e.message}`, 'fix or delete config.json (defaults are used if absent)'); }
} catch { add('warn', 'config.json valid', true, 'absent — built-in defaults in use'); }

const criticalFails = checks.filter((c) => c.level === 'critical' && !c.ok);
const warnFails = checks.filter((c) => c.level === 'warn' && !c.ok);
const healthy = criticalFails.length === 0;

if (jsonMode) {
    process.stdout.write(JSON.stringify({
        schema_version: 1,
        healthy,
        install_home: INSTALL_HOME,
        hooks_dir: HOOKS_DIR,
        settings_path: SETTINGS_PATH,
        critical_failures: criticalFails.length,
        warnings: warnFails.length,
        checks,
    }, null, 2) + '\n');
    process.exit(healthy ? 0 : 1);
}

console.log('=== Compact Controller Doctor ===\n');
console.log(`Install home:  ${INSTALL_HOME}`);
console.log(`Hooks dir:     ${HOOKS_DIR}`);
console.log(`Settings:      ${SETTINGS_PATH}\n`);
for (const c of checks) {
    const mark = c.ok ? 'OK  ' : (c.level === 'critical' ? 'FAIL' : 'WARN');
    console.log(`[${mark}] ${c.name}${c.detail ? '  — ' + c.detail : ''}`);
    if (!c.ok && c.fix) console.log(`         ↳ ${c.fix}`);
}
console.log('');
if (healthy && warnFails.length === 0) {
    console.log('All checks passed — the controller is installed and healthy.');
} else if (healthy) {
    console.log(`Healthy, with ${warnFails.length} warning(s) above (the controller still runs).`);
} else {
    console.log(`${criticalFails.length} critical problem(s) — the controller will NOT run until fixed. See the ↳ fixes above.`);
}
console.log('\nTip: after any install/uninstall, restart Claude Code for hook changes to take effect.');
process.exit(healthy ? 0 : 1);
