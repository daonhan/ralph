import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runLoop } from "./loop.js";
import { STAGES } from "./stages.js";

export async function runGhAfk(argv: string[]): Promise<void> {
  const [iterationsArg] = argv;
  if (!iterationsArg) {
    console.error("Usage: ralph-ghafk <iterations>");
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
    stages: [STAGES.ghafkImplementer, STAGES.reviewer],
    inputs: "",
    iterations,
    ralphDir,
    workspaceDir,
    sandcastleDir,
  });
}
