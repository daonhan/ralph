import { join } from "node:path";

import { renderTemplate } from "./render.js";
import { ensureImage, runStage, USE_COLOR, dim, bold, greenOut, boldOut, dimOut, SYM_OUT } from "./runner.js";
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
      const banner = USE_COLOR
        ? `${dim("\u2501\u2501\u2501")} ${bold(`iteration ${i}/${iterations}`)} ${dim("\u00b7")} ${bold(stage.name)} ${dim(`(stage ${s + 1}/${stages.length})`)} ${dim("\u2501\u2501\u2501")}`
        : `== iteration ${i}/${iterations} \u00b7 ${stage.name} (stage ${s + 1}/${stages.length}) ==`;
      process.stderr.write(`\n${banner}\n`);
      const templatePath = join(sandcastleDir, "templates", stage.template);
      const prompt = renderTemplate(templatePath, { INPUTS: inputs }, { cwd: workspaceDir });
      const result = await runStage(stage, prompt, workspaceDir, i);
      if (s === 0) {
        gateResult = result;
        if (gateResult.includes(SENTINEL)) {
          const msg = greenOut(SYM_OUT.bullet) + " " + boldOut("Ralph complete") + dimOut(" after " + i + " iterations");
          process.stdout.write(msg + "\n");
          return;
        }
      }
    }
  }
}
