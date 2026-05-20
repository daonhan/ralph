import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runLoop } from "./loop.js";
import { STAGES } from "./stages.js";

export async function runAfk(argv: string[]): Promise<void> {
  const [planAndPrd, iterationsArg] = argv;
  if (!planAndPrd || !iterationsArg) {
    console.error("Usage: ralph-afk <plan-and-prd> <iterations>");
    process.exit(1);
  }
  const iterations = Number.parseInt(iterationsArg, 10);
  if (!Number.isFinite(iterations) || iterations < 1) {
    console.error(`Invalid iterations: ${iterationsArg}`);
    process.exit(1);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const sandcastleDir = resolve(here, "..");
  const workspaceDir = resolve(process.env.RALPH_WORKSPACE ?? process.cwd());
  const ralphDir = resolve(process.env.RALPH_DOCKER_CONTEXT ?? workspaceDir);

  await runLoop({
    stages: [STAGES.implementer, STAGES.reviewer],
    inputs: planAndPrd,
    iterations,
    ralphDir,
    workspaceDir,
    sandcastleDir,
  });
}
