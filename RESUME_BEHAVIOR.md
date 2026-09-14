# Resume Behavior Documentation

## Overview

The video agent automatically resumes the most recently updated previous run when the same normalized prompt is used. This allows continuation of video generation tasks while reusing already-generated artifacts from disk. Each run is single-writer: wait for or cancel an active invocation before starting the same prompt or run ID again. Different prompts use different run directories and may run concurrently.

## How It Works

### Prompt-Based Run Identification

1. **Prompt Hashing**: Each prompt is normalized and hashed to create a unique identifier
   - Normalization: trim, lowercase, collapse whitespace
   - Hash: SHA-256 of the normalized prompt

2. **Run Directory Lookup**: When a new prompt is submitted:
   - The system searches for existing run directories with the same prompt hash
   - If found, the most recently updated run is reused
   - If not found, a new run directory is created

### Artifact Reuse

When resuming a run, the system automatically:

1. **Loads existing checkpoints** from the previous run:
   - Video generation (Agnes)
   - Foley/sound effects (ElevenLabs)
   - Background music (Free.ai)
   - Final assembled video

2. **Validates artifacts** to ensure they're still usable:
   - Checks file integrity (SHA-256)
   - Verifies compatibility with current configuration
   - Ensures mix revisions are current

3. **Continues from the last completed step**:
   - If video is complete but music is missing → generates music
   - If all artifacts exist but assembly failed → reassembles
   - If everything is complete → exits immediately with success message

### State Synchronization

The system maintains state in several files within each run directory:

- `run.json`: Run metadata (ID, prompt hash, timestamps)
- `pipeline-state.json`: Checkpoint data for each generation step
- `plan.json`: Locked video plan (reused on resume)
- Individual artifact files (video, audio, etc.)

Each local state-file update is atomically published for consistency across process restarts. These files do not provide cross-process locking or transactions, so simultaneous writers for one run are unsupported.

## User Experience

### First Run
```bash
npm run dev -- "Create a video of a cat playing"
# Output: Started run: abc123...
# Generates video, audio, music, assembles final video
```

### Subsequent Runs (Same Prompt)
```bash
npm run dev -- "Create a video of a cat playing"
# Output: Resuming run: abc123...
# Output: Task already complete. Reusing artifacts from previous run.
# Output: Final video: /path/to/final.mp4
```

### Different Prompt
```bash
npm run dev -- "Create a video of a dog running"
# Output: Started run: def456...
# Creates a new run with a different ID
```

## Benefits

1. **Cost Savings**: Avoid regenerating expensive AI artifacts
2. **Time Savings**: Skip completed steps, continue from failures
3. **Reliability**: Survive crashes and restarts without losing progress
4. **Consistency**: The same normalized prompt reuses the latest matching run and its artifacts

## Implementation Details

### Key Functions

- `ensureLocalRunIndex()`: Creates or finds existing run for a prompt
- `findExistingRunByPromptHash()`: Searches for runs with matching prompt hash
- `reconcileDueMediaCheckpoints()`: Resumes in-progress provider tasks
- `validateCompletedFinalVideoForState()`: Checks if run is already complete

### Files Modified

1. **src/run-index.ts**:
   - Added `findExistingRunByPromptHash()` function
   - Changed `createLocalRunIndex()` to `ensureLocalRunIndex()`
   - Now searches for existing runs before creating new ones

2. **src/cli.ts**:
   - Updated to use `ensureLocalRunIndex()` instead of `createLocalRunIndex()`
   - Added better logging for resumed runs
   - Enhanced completion messages

3. **test/run-resume.test.ts**:
   - New test suite validating resume behavior
   - Tests for prompt reuse, distinct-prompt isolation, and state management

## Edge Cases Handled

1. **Multiple legacy runs with the same prompt**: Returns the most recently updated
2. **Corrupted run directories**: Skipped during search
3. **Stale artifacts**: Validated and regenerated if needed
4. **Configuration changes**: Detected and handled appropriately
5. **Provider changes**: Old artifacts from different providers are replaced

## Choosing a Run

Use `--resume` to continue a specific existing run ID. It does not force a new run or bypass prompt-based reuse:

```bash
# List existing runs
ls runs/

# Resume a specific run
npm run dev -- --resume <run-id>
```

There is currently no force-new flag for an identical normalized prompt. If you need an independent run, use a meaningfully different prompt or a separate `VIDEO_OUTPUT_ROOT`. Never delete or modify a run directory while an invocation is active.

Repeating the exact prompt is the convenient resume path; it selects the most recently updated matching run. Do not launch two identical prompt invocations simultaneously, because both would select the same single-writer local state.

## Backward Compatibility

The changes are fully backward compatible:

- Old run directories (using prompt hash as run ID) are still supported
- Legacy checkpoints are automatically migrated
- The deprecated `createLocalRunIndex` is aliased to `ensureLocalRunIndex`
