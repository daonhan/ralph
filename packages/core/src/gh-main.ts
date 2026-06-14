import { runBin } from "./run-bin.js";
import { STAGES } from "./stages.js";

export type RunGhAfkOptions = { cliVersion?: string };

export async function runGhAfk(
  argv: string[],
  opts: RunGhAfkOptions = {}
): Promise<void> {
  await runBin(argv, {
    bin: "ralph-ghafk",
    usage: "<iterations>",
    desc: "GitHub-issue-driven Claude Code AFK loop",
    stages: [STAGES.ghafkImplementer, STAGES.reviewer],
    takesInputArg: false,
    cliVersion: opts.cliVersion,
    supportsWatch: true,
  });
}
