import { join } from "node:path";

import { renderTemplate } from "./render.js";
import { ensureImage, runStage } from "./runner.js";
import type { Stage } from "./stages.js";

const SENTINEL = "<promise>NO MORE TASKS</promise>";

export type LoopOptions = {
  // First stage is the gate: its result is checked for the completion sentinel.
  // Subsequent stages always run after a non-sentinel gate result.
  stages: [Stage, ...Stage[]];
  inputs: string;
  iterations: number;
  ralphDir: string;
  workspaceDir: string;
  sandcastleDir: string;
};

export async function runLoop(opts: LoopOptions): Promise<void> {
  const { stages, inputs, iterations, ralphDir, workspaceDir, sandcastleDir } = opts;

  ensureImage(ralphDir);

  for (let i = 1; i <= iterations; i++) {
    let gateResult = "";
    for (let s = 0; s < stages.length; s++) {
      const stage = stages[s];
      process.stderr.write(
        `\n[sandcastle] iteration ${i}/${iterations} stage ${s + 1}/${stages.length} (${stage.name})\n`
      );
      const templatePath = join(sandcastleDir, "templates", stage.template);
      const prompt = renderTemplate(templatePath, { INPUTS: inputs }, { cwd: workspaceDir });
      const result = await runStage(stage, prompt, workspaceDir, i);
      if (s === 0) {
        gateResult = result;
        if (gateResult.includes(SENTINEL)) {
          console.log(`Ralph complete after ${i} iterations.`);
          return;
        }
      }
    }
  }
}
