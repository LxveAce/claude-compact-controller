#!/usr/bin/env node

// Stop hook: fires after every Claude response.
// Tracks cumulative token usage and turn count in persistent state.
// input_tokens = full context window size for that turn (not incremental).

const { readStdin, loadState, saveState, ensureDirs, log } = require('../lib/shared');

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
        }

        state.session_id = hookData.session_id || state.session_id;
        state.input_tokens = hookData.input_tokens || state.input_tokens;
        state.output_tokens = (state.output_tokens || 0) + (hookData.output_tokens || 0);
        state.turn_count = (state.turn_count || 0) + 1;
        state.last_stop_reason = hookData.stop_reason;
        state.last_transcript_path = hookData.transcript_path;

        saveState(state);
        log(`Stop: ${state.input_tokens} in / +${hookData.output_tokens || 0} out / turn ${state.turn_count}`);
    } catch (e) {
        // Hooks must never crash Claude Code
        process.exit(0);
    }
})();
