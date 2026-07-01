#!/usr/bin/env node

// Stop hook: fires after every Claude response.
// Tracks token usage and turn count in persistent state.
//
// The Stop payload itself does NOT include token fields, so usage is read from
// the session transcript (JSONL): input_tokens = the full context-window size
// for the most recent turn (fresh + cache-read + cache-created), and
// output_tokens is accumulated across turns.

const { readStdin, loadState, saveState, ensureDirs, readLatestUsageFromTranscript, log } = require('../lib/shared');

(async () => {
    try {
        const hookData = await readStdin();
        if (!hookData) process.exit(0);

        ensureDirs();
        const state = loadState();

        const isNewSession = hookData.session_id && hookData.session_id !== state.session_id;
        if (isNewSession) {
            state.output_tokens = 0;
            state.turn_count = 0;
            state.vault_count = 0;
            state.last_usage_uuid = null;
        }

        state.session_id = hookData.session_id || state.session_id;
        state.last_transcript_path = hookData.transcript_path || state.last_transcript_path;

        // Read real usage from the transcript (the Stop payload has none).
        const usage = readLatestUsageFromTranscript(state.last_transcript_path);
        if (usage) {
            state.input_tokens = usage.context_tokens;
            // Accumulate output across turns, de-duped on the assistant message
            // uuid so a repeated Stop on the same final message never double-counts.
            if (!usage.uuid || usage.uuid !== state.last_usage_uuid) {
                state.output_tokens = (state.output_tokens || 0) + usage.output_tokens;
                if (usage.uuid) state.last_usage_uuid = usage.uuid;
            }
        }

        state.turn_count = (state.turn_count || 0) + 1;
        state.last_stop_reason = hookData.stop_reason
            || (usage && usage.stop_reason)
            || state.last_stop_reason
            || null;

        saveState(state);
        log(`Stop: ${state.input_tokens || 0} ctx / ${state.output_tokens || 0} out(cum) / turn ${state.turn_count}`);
    } catch (e) {
        // Hooks must never crash Claude Code
        process.exit(0);
    }
})();
