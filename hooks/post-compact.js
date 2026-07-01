#!/usr/bin/env node

// Post-compaction recovery hook — registered under SessionStart (matcher: "compact"), which fires after
// auto OR manual compaction. It must be SessionStart, not PostCompact: PostCompact has no decision control
// and cannot return additionalContext, so a pointer injected there is silently dropped. SessionStart
// supports additionalContext, so the vault reference actually reaches the model. Also resets the counters.

const fs = require('fs');
const path = require('path');
const { readStdin, loadState, saveState, ensureDirs, VAULT_DIR, log } = require('../lib/shared');

(async () => {
    try {
        const hookData = await readStdin();
        ensureDirs();

        const state = loadState();

        // Find latest vault backup
        let vaultContext = '';
        try {
            const vaultFiles = fs.readdirSync(VAULT_DIR)
                .filter(f => f.startsWith('vault-') && f.endsWith('.json'))
                .sort()
                .reverse();

            if (vaultFiles.length > 0) {
                const latestPath = path.join(VAULT_DIR, vaultFiles[0]);
                const vault = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
                vaultContext = [
                    '[Compact Controller] Context was just compacted.',
                    `A pre-compact vault backup exists at: ${latestPath}`,
                    `It contains the last ${vault.turn_count} turns (~${vault.context_tokens} context tokens) from before compaction.`,
                    'If you need context that was lost during compaction, read the vault file.'
                ].join(' ');
            }
        } catch {}

        // Reset counters for fresh post-compact tracking
        state.input_tokens = 0;
        state.output_tokens = 0;
        state.turn_count = 0;
        saveState(state);

        log('SessionStart(compact): counters reset, vault reference injected');

        const output = {
            continue: true,
            hookSpecificOutput: {
                hookEventName: 'SessionStart',
                additionalContext: vaultContext
            }
        };

        process.stdout.write(JSON.stringify(output));
    } catch (e) {
        process.stdout.write(JSON.stringify({ continue: true }));
    }
    process.exit(0);
})();
