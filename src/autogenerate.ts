import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { runCli } from "./cli.js";
import { pauseVmBeforeExit } from "./pause.js";
import {
  findEligibleAutogenerateRuns,
  hasVideoAlreadyGeneratedOnDisk,
} from "./state/autogenerateRuns.js";

export async function autogenerateMain(): Promise<void> {
  const config = loadConfig();
  const outputRoot = path.resolve(config.VIDEO_OUTPUT_ROOT);

  console.log(`[autogenerate] Checking for pending Agnes runs in: ${outputRoot}`);
  const eligibleRuns = await findEligibleAutogenerateRuns(outputRoot);

  if (eligibleRuns.length === 0) {
    console.log("[autogenerate] No pending Agnes runs found to auto-generate.");
    return;
  }

  const selected = eligibleRuns[0];
  if (!selected) {
    console.log("[autogenerate] No pending Agnes runs found to auto-generate.");
    return;
  }
  console.log(`[autogenerate] Found ${eligibleRuns.length} eligible run(s).`);
  console.log(
    `[autogenerate] Processing oldest eligible run: ${selected.runId} ` +
    `(created: ${selected.createdAt}, manifest: ${selected.manifestStatus}, sourceStatus: ${selected.sourceStatus ?? "none"}, hasProviderJob: ${selected.hasProviderJob})`
  );
  console.log(`[autogenerate] Original prompt: "${selected.originalPrompt}"`);

  // Double-check if video is already generated on disk for this run
  const videoAlreadyOnDisk = await hasVideoAlreadyGeneratedOnDisk(selected.runDirectory);
  if (videoAlreadyOnDisk) {
    console.log(`[autogenerate] Video is already generated on disk for run ${selected.runId}. Skipping.`);
    return;
  }

  await runCli(["--resume", selected.runId]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let pausePromise: Promise<void> | undefined;
  const pauseOnce = (): Promise<void> => {
    pausePromise ??= pauseVmBeforeExit();
    return pausePromise;
  };
  const handleTerminationSignal = (signal: NodeJS.Signals): void => {
    const exitCode = signal === "SIGINT" ? 130 : 143;
    void pauseOnce().finally(() => process.exit(exitCode));
  };

  process.once("SIGINT", handleTerminationSignal);
  process.once("SIGTERM", handleTerminationSignal);

  autogenerateMain().catch((error) => {
    console.error(`[autogenerate] Task failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }).finally(async () => {
    await pauseOnce();
  });
}
