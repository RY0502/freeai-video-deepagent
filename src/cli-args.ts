export type CliCommand =
  | { kind: "run"; prompt: string; youtubeUploadRequested: boolean }
  | { kind: "resume"; runId: string }
  | { kind: "status"; runId: string }
  | { kind: "help" };

const RUN_ID = /^[a-f0-9]{64}$/;

function requireRunId(value: string | undefined, flag: string): string {
  if (!value || !RUN_ID.test(value)) {
    throw new Error(`${flag} requires a 64-character lowercase hexadecimal run id`);
  }
  return value;
}

export function parseCliArgs(args: string[]): CliCommand {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    return { kind: "help" };
  }
  if (args[0] === "--resume") {
    if (args.length !== 2) throw new Error("--resume accepts exactly one run id");
    return { kind: "resume", runId: requireRunId(args[1], "--resume") };
  }
  if (args[0] === "--status") {
    if (args.length !== 2) throw new Error("--status accepts exactly one run id");
    return { kind: "status", runId: requireRunId(args[1], "--status") };
  }
  if (args[0] === "--youtube") {
    const prompt = args.slice(1).join(" ").trim();
    if (!prompt) throw new Error("--youtube requires a video prompt");
    if (args.slice(1).some((value) => value.startsWith("--"))) {
      throw new Error("--youtube accepts only a video prompt");
    }
    return { kind: "run", prompt, youtubeUploadRequested: true };
  }
  if (args[0]?.startsWith("-")) {
    throw new Error(`Unknown option: ${args[0]}`);
  }

  const prompt = args.join(" ").trim();
  if (!prompt) return { kind: "help" };
  return { kind: "run", prompt, youtubeUploadRequested: false };
}

export const CLI_HELP = `Usage:
  npm run dev -- "Create a short video (up to twelve seconds) about ..."
  npm run dev -- --youtube "Create a short video and publish it"
  npm run dev -- --resume <run-id>
  npm run dev -- --status <run-id>

Each prompt command starts an isolated run, so identical prompts may execute
concurrently. Accepted Agnes tasks are continued with --resume and their run ID.
Resume uses the stored original prompt and never duplicates an accepted task.
YouTube publication additionally requires --youtube and enabled OAuth settings.`;
