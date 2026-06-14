import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { renderTemplate } from "./render.js";
import { DEFAULT_BACKOFF_MS, backoffFor, withRetries } from "./retry.js";
import { runStage, stageLogPath, type StageResult } from "./runner.js";
import { USE_COLOR, dim } from "./stream-render.js";
import type { Stage } from "./stages.js";

export type ExecuteStageOptions = {
  stage: Stage;
  vars: Record<string, string>;
  workspaceDir: string;
  packageDir: string;
  iteration: number;
  maxRetries: number;
  signal?: AbortSignal;
  /** Disambiguates spill/log paths when multiple sub-stages share an iteration (panel lenses). */
  logLabel?: string;
};

/** Render a stage's template (inside the retry, so flaky shell tags retry) and run it. */
export async function executeStage(
  opts: ExecuteStageOptions
): Promise<StageResult> {
  const {
    stage,
    vars,
    workspaceDir,
    packageDir,
    iteration,
    maxRetries,
    signal,
  } = opts;
  const label = opts.logLabel ?? stage.name;
  const spillRel = `spill-${process.pid}-${iteration}-${label}-${Date.now()}`;
  const spillHostDir = join(workspaceDir, ".ralph-tmp", spillRel);
  const spillRefPath = posix.join(".ralph-tmp", spillRel);
  const stageLog = stageLogPath(workspaceDir, iteration, label);
  mkdirSync(dirname(stageLog), { recursive: true });

  return withRetries(
    () => {
      const prompt = renderTemplate(
        join(packageDir, "templates", stage.template),
        vars,
        { cwd: workspaceDir, spillHostDir, spillRefPath }
      );
      return runStage(
        stage,
        prompt,
        workspaceDir,
        iteration,
        spillHostDir,
        stageLog,
        { signal }
      );
    },
    {
      max: maxRetries,
      backoffMs: DEFAULT_BACKOFF_MS,
      onAttempt: (attempt, err) => {
        const wait = backoffFor(DEFAULT_BACKOFF_MS, attempt);
        const marker = `[retry] attempt ${attempt} of ${maxRetries} after ${wait} ms`;
        process.stderr.write(
          `${USE_COLOR ? dim(marker) : marker} ${dim("(" + (err as Error).message + ")")}\n`
        );
        try {
          appendFileSync(stageLog, marker + "\n");
        } catch {
          // log file may be unwritable; never crash on the marker.
        }
      },
    }
  );
}
