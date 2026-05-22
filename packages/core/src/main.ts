import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseFlags,
  printConfig,
  printHelp,
  printVersion,
} from "./cli-help.js";
import { runLoop } from "./loop.js";
import { STAGES } from "./stages.js";

const BIN = "ralph-afk";
const USAGE = "<plan-and-prd> <iterations>";
const DESC = "plan/PRD-driven Claude Code AFK loop";

export type RunAfkOptions = { cliVersion?: string };

export async function runAfk(
  argv: string[],
  opts: RunAfkOptions = {}
): Promise<void> {
  const flags = parseFlags(argv);

  if (flags.version) {
    printVersion(BIN, opts.cliVersion);
    return;
  }
  if (flags.help) {
    printHelp(BIN, USAGE, DESC);
    return;
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const sandcastleDir = resolve(here, "..");
  const workspaceDir = resolve(process.env.RALPH_WORKSPACE ?? process.cwd());
  const ralphDir = resolve(process.env.RALPH_DOCKER_CONTEXT ?? sandcastleDir);

  if (flags.printConfig) {
    printConfig(BIN, workspaceDir, ralphDir, sandcastleDir, opts.cliVersion);
    return;
  }

  const [planAndPrd, iterationsArg] = flags.rest;
  if (!planAndPrd || !iterationsArg) {
    console.error(`Usage: ${BIN} ${USAGE}`);
    console.error(`       ${BIN} --help`);
    process.exit(1);
  }
  const iterations = Number.parseInt(iterationsArg, 10);
  if (!Number.isFinite(iterations) || iterations < 1) {
    console.error(`Invalid iterations: ${iterationsArg}`);
    process.exit(1);
  }

  await runLoop({
    stages: [STAGES.implementer, STAGES.reviewer],
    inputs: planAndPrd,
    iterations,
    ralphDir,
    workspaceDir,
    sandcastleDir,
  });
}
