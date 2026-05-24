import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";

import { acquire, type Releaser } from "./keepalive.js";
import { notifyComplete, notifyError } from "./notify.js";
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
  /** When true, fire OS notification + bell on loop terminal events. Default: false. */
  notify?: boolean;
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
    notify = false,
  } = opts;

  const releaser: Releaser = noKeepAlive
    ? { release: () => {} }
    : acquire({ reason: "ralph-afk loop" });
  const stageAbort = new AbortController();

  // Single release path: signal handlers and the finally below all funnel
  // through releaseOnce so the wake-lock child is killed exactly once.
  let released = false;
  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    releaser.release();
  };
  const abortActiveStage = (): void => {
    if (!stageAbort.signal.aborted) stageAbort.abort();
  };

  const onSigint = (): void => {
    abortActiveStage();
    if (notify) notifyError("interrupted (SIGINT)");
    releaseOnce();
    process.exit(130);
  };
  const onSigterm = (): void => {
    abortActiveStage();
    if (notify) notifyError("terminated (SIGTERM)");
    releaseOnce();
    process.exit(143);
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  let completedIterations = 0;
  let sentinelHit = false;
  try {
    await ensureImage(ralphDir, { signal: stageAbort.signal });

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
              runStage(stage, prompt, workspaceDir, i, spillHostDir, stageLog, {
                signal: stageAbort.signal,
              }),
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
          const failureMarker = `[failure] iteration ${i} stage ${stage.name} failed after ${maxRetries} retries: ${(err as Error).message}`;
          try {
            appendFileSync(stageLog, failureMarker + "\n");
          } catch {
            // log file may be unwritable; stderr still carries the failure.
          }
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
            sentinelHit = true;
            completedIterations = i;
            return;
          }
        }
      }
      completedIterations = i;
    }
  } catch (err) {
    if (notify) notifyError((err as Error).message);
    throw err;
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    releaseOnce();
    if (notify && (sentinelHit || completedIterations === iterations)) {
      notifyComplete(completedIterations, sentinelHit);
    }
  }
}
