import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";

import { acquire, type Releaser } from "./keepalive.js";
import { renderTemplate } from "./render.js";
import {
  DEFAULT_BACKOFF_MS,
  DEFAULT_MAX_RETRIES,
  backoffFor,
  withRetries,
} from "./retry.js";
import {
  ensureImage,
  runStage,
  stageLogPath,
  USE_COLOR,
  dim,
  bold,
  red,
  greenOut,
  boldOut,
  dimOut,
  SYM,
  SYM_OUT,
} from "./runner.js";
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
  /** When true, skip OS wake-lock acquisition. Default: false. */
  noKeepAlive?: boolean;
  /** Per-stage retry budget. Default: 3. Set to 0 to disable retries. */
  maxRetries?: number;
};

export async function runLoop(opts: LoopOptions): Promise<void> {
  const {
    stages,
    inputs,
    iterations,
    ralphDir,
    workspaceDir,
    sandcastleDir,
    noKeepAlive = false,
    maxRetries = DEFAULT_MAX_RETRIES,
  } = opts;

  ensureImage(ralphDir);

  const releaser: Releaser = noKeepAlive
    ? { release: () => {} }
    : acquire({ reason: "ralph-afk loop" });

  // Single release path: signal handlers and the finally below all funnel
  // through releaseOnce so the wake-lock child is killed exactly once.
  let released = false;
  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    releaser.release();
  };

  const onSigint = (): void => {
    releaseOnce();
    process.exit(130);
  };
  const onSigterm = (): void => {
    releaseOnce();
    process.exit(143);
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  try {
    for (let i = 1; i <= iterations; i++) {
      for (let s = 0; s < stages.length; s++) {
        const stage = stages[s];
        const banner = USE_COLOR
          ? `${dim("\u2501\u2501\u2501")} ${bold(`iteration ${i}/${iterations}`)} ${dim("\u00b7")} ${bold(stage.name)} ${dim(`(stage ${s + 1}/${stages.length})`)} ${dim("\u2501\u2501\u2501")}`
          : `== iteration ${i}/${iterations} \u00b7 ${stage.name} (stage ${s + 1}/${stages.length}) ==`;
        process.stderr.write(`\n${banner}\n`);
        const templatePath = join(sandcastleDir, "templates", stage.template);
        const spillRel = `spill-${process.pid}-${i}-${s}-${Date.now()}`;
        const spillHostDir = join(workspaceDir, ".ralph-tmp", spillRel);
        const spillRefPath = posix.join(".ralph-tmp", spillRel);
        const prompt = renderTemplate(
          templatePath,
          { INPUTS: inputs },
          { cwd: workspaceDir, spillHostDir, spillRefPath }
        );

        const stageLog = stageLogPath(workspaceDir, i, stage.name);
        mkdirSync(dirname(stageLog), { recursive: true });

        let result: string;
        try {
          result = await withRetries(
            () =>
              runStage(stage, prompt, workspaceDir, i, spillHostDir, stageLog),
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
                  // log file may be unwritable; never crash the loop on the marker.
                }
              },
            }
          );
        } catch (err) {
          const msg = `${red(SYM.cross)} ${bold("iteration " + i + " stage " + stage.name + " failed")} after ${maxRetries} retries: ${(err as Error).message}`;
          process.stderr.write(msg + "\n");
          break;
        }

        if (s === 0) {
          if (result.includes(SENTINEL)) {
            const msg =
              greenOut(SYM_OUT.bullet) +
              " " +
              boldOut("Ralph complete") +
              dimOut(" after " + i + " iterations");
            process.stdout.write(msg + "\n");
            return;
          }
        }
      }
    }
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    releaseOnce();
  }
}
