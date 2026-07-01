'use strict';

// Unit tests for the transcript-usage parser that backs the Stop hook's token
// tracking. Pure, hardware-free: reads a fixture JSONL from disk.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { readLatestUsageFromTranscript } = require('../lib/shared');

const FIXTURE = path.join(__dirname, 'fixtures', 'transcript-usage.jsonl');

test('picks the most recent main-chain assistant usage (skips sidechain/garbage)', () => {
    const u = readLatestUsageFromTranscript(FIXTURE);
    assert.ok(u, 'expected a usage object');
    assert.strictEqual(u.uuid, 'A2', 'should pick the last non-sidechain assistant');
    assert.strictEqual(u.output_tokens, 80);
    assert.strictEqual(u.stop_reason, 'end_turn');
});

test('context_tokens = input + cache_read + cache_creation', () => {
    const u = readLatestUsageFromTranscript(FIXTURE);
    assert.strictEqual(
        u.context_tokens,
        u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
    );
    assert.strictEqual(u.context_tokens, 227); // 7 + 200 + 20
});

test('token fields are non-zero (the exact bug that shipped as 0/0)', () => {
    const u = readLatestUsageFromTranscript(FIXTURE);
    assert.ok(u.context_tokens > 0, 'context_tokens should be > 0');
    assert.ok(u.output_tokens > 0, 'output_tokens should be > 0');
});

test('missing / empty / null paths return null (no throw)', () => {
    assert.strictEqual(readLatestUsageFromTranscript(''), null);
    assert.strictEqual(readLatestUsageFromTranscript(null), null);
    assert.strictEqual(readLatestUsageFromTranscript(path.join(os.tmpdir(), 'nope-does-not-exist.jsonl')), null);
});

test('a transcript with no assistant-usage lines returns null', () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-parse-')), 't.jsonl');
    fs.writeFileSync(tmp, '{"type":"user","message":{"role":"user","content":"hi"}}\ngarbage\n');
    try {
        assert.strictEqual(readLatestUsageFromTranscript(tmp), null);
    } finally {
        fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
    }
});

test('non-finite token values are coerced to 0', () => {
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cc-parse-')), 't.jsonl');
    fs.writeFileSync(
        tmp,
        JSON.stringify({
            type: 'assistant', uuid: 'X',
            message: { role: 'assistant', usage: { input_tokens: 'nan', output_tokens: null } }
        }) + '\n'
    );
    try {
        const u = readLatestUsageFromTranscript(tmp);
        assert.strictEqual(u.input_tokens, 0);
        assert.strictEqual(u.output_tokens, 0);
        assert.strictEqual(u.context_tokens, 0);
    } finally {
        fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
    }
});
