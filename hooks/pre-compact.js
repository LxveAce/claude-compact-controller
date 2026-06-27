#!/usr/bin/env node

// PreCompact hook (matcher: "auto"): fires before auto-compaction.
// Saves a vault backup of the conversation tail so context survives compaction.
// Outputs JSON with additionalContext to inform Claude about the vault.

const fs = require('fs');
const path = require('path');
const { readStdin, loadState, saveState, ensureDirs, VAULT_DIR, loadConfig, log, atomicWriteFileSync } = require('../lib/shared');

(async () => {
    try {
        const hookData = await readStdin();
        ensureDirs();

        const state = loadState();
        const config = loadConfig();

        // Read transcript tail for vault backup
        const transcriptPath = hookData?.transcript_path || state.last_transcript_path;
        let transcriptTail = '';

        if (transcriptPath && fs.existsSync(transcriptPath)) {
            try {
                const stats = fs.statSync(transcriptPath);
                const tailBytes = config.vault_transcript_tail_bytes || 50000;
                const readSize = Math.min(tailBytes, stats.size);
                const start = Math.max(0, stats.size - tailBytes);

                const fd = fs.openSync(transcriptPath, 'r');
                const buffer = Buffer.alloc(readSize);
                fs.readSync(fd, buffer, 0, readSize, start);
                fs.closeSync(fd);

                transcriptTail = buffer.toString('utf8');
                // Drop partial first line if we started mid-file
                if (start > 0) {
                    const nl = transcriptTail.indexOf('\n');
                    if (nl > 0) transcriptTail = transcriptTail.substring(nl + 1);
                }
            } catch (e) {
                transcriptTail = `[Error reading transcript: ${e.message}]`;
            }
        }

        // Build vault entry
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const vaultEntry = {
            timestamp: new Date().toISOString(),
            session_id: hookData?.session_id || state.session_id,
            trigger: 'auto-compact',
            context_tokens: state.input_tokens || 0,
            output_tokens_total: state.output_tokens || 0,
            turn_count: state.turn_count || 0,
            cwd: hookData?.cwd || '',
            transcript_tail: transcriptTail
        };

        const vaultFile = path.join(VAULT_DIR, `vault-${ts}.json`);
        atomicWriteFileSync(vaultFile, JSON.stringify(vaultEntry, null, 2));

        // Prune old vaults: keep exactly the newest `maxVaults` files.
        // Sorted ascending (oldest first); everything except the trailing
        // `maxVaults` entries is deleted. `slice(0, -maxVaults)` returns the
        // oldest files to remove, so exactly `maxVaults` newest are retained.
        const maxVaults = config.vault_max_entries || 10;
        const vaultFiles = fs.readdirSync(VAULT_DIR)
            .filter(f => f.startsWith('vault-') && f.endsWith('.json'))
            .sort();

        const toDelete = maxVaults > 0 ? vaultFiles.slice(0, -maxVaults) : vaultFiles;
        for (const old of toDelete) {
            try { fs.unlinkSync(path.join(VAULT_DIR, old)); } catch {}
        }

        // Update state
        state.vault_count = (state.vault_count || 0) + 1;
        state.last_vault_file = vaultFile;
        saveState(state);

        log(`PreCompact: vault saved (${state.turn_count} turns, ~${state.input_tokens} tokens) -> ${vaultFile}`);

        // Allow compact, inject vault context
        const output = {
            continue: true,
            hookSpecificOutput: {
                hookEventName: 'PreCompact',
                additionalContext: [
                    '[Compact Controller] Pre-compact vault backup saved.',
                    `Session had ${state.turn_count} turns with ~${state.input_tokens} context tokens.`,
                    `Vault file: ${vaultFile}`,
                    'If you lose important context after compaction, read the vault file above.'
                ].join(' ')
            }
        };

        process.stdout.write(JSON.stringify(output));
    } catch (e) {
        // Never block compact on error - just allow it
        process.stdout.write(JSON.stringify({ continue: true }));
    }
    process.exit(0);
})();
