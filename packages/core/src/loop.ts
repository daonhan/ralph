import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, posix } from "node:path";

import { readCoreVersion } from "./cli-help.js";
import { acquire, type Releaser } from "./keepalive.js";
import { notifyComplete, notifyError } from "./notify.js";
import { renderTemplate } from "./render.js";
import {
  DEFAULT_BACKOFF_MS,
  DEFAULT_MAX_RETRIES,
  backoffFor,
  withRetries,
} from "./retry.js";
import { ensureImage, runStage, stageLogPath } from "./runner.js";
import {
  USE_COLOR,
  dim,
  bold,
  red,
  greenOut,
  boldOut,
  dimOut,
  SYM,
  SYM_OUT,
} from "./stream-render.js";
import type { Stage } from "./stages.js";

// The agent emits this literal when there is no more work; the same string is
// mirrored in the playbook templates (prompt.md / ghprompt.md) that instruct it.
const SENTINEL = "<promise>NO MORE TASKS</promise>";

export type LoopOptions = {
  // First stage is the gate: its result is checked for the completion sentinel.
  // Subsequent stages always run after a non-sentinel gate result.
  stages: [Stage, ...Stage[]];
  inputs: string;
  iterations: number;
  /** Docker `build` fallback context (must contain a Dockerfile). */
  ralphDir: string;
  /** Host repo bind-mounted into the sandbox at /home/agent/workspace. */
  workspaceDir: string;
  /** Installed @daonhan/ralph-core dir; stage templates are read from <packageDir>/templates. */
  packageDir: string;
  /** When true, skip OS wake-lock acquisition. Default: false. */
  noKeepAlive?: boolean;
  /** Per-stage retry budget. Default: 3. Set to 0 to disable retries. */
  maxRetries?: number;
  /** When true, fire OS notification + bell on loop terminal events. Default: false. */
  notify?: boolean;
  /** Bin name for the init-time version banner (e.g. "ralph-afk"). */
  bin?: string;
  /** CLI version for the init-time version banner. */
  cliVersion?: string;
};

export async function runLoop(opts: LoopOptions): Promise<void> {
  const {
    stages,
    inputs,
    iterations,
    ralphDir,
    workspaceDir,
    packageDir,
    noKeepAlive = false,
    maxRetries = DEFAULT_MAX_RETRIES,
    notify = false,
    bin = "ralph",
    cliVersion = "?",
  } = opts;

  const versionLine = `${bin} ${cliVersion} (core ${readCoreVersion()})`;
  process.stderr.write(
    `${USE_COLOR ? `${dim("━━━")} ${bold(versionLine)} ${dim("━━━")}` : `== ${versionLine} ==`}\n`
  );

  const releaser: Releaser = noKeepAlive
    ? { release: () => {} }
    : acquire({ reason: `${bin} loop` });
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
        const templatePath = join(packageDir, "templates", stage.template);
        const spillRel = `spill-${process.pid}-${i}-${s}-${Date.now()}`;
        const spillHostDir = join(workspaceDir, ".ralph-tmp", spillRel);
        const spillRefPath = posix.join(".ralph-tmp", spillRel);

        const stageLog = stageLogPath(workspaceDir, i, stage.name);
        mkdirSync(dirname(stageLog), { recursive: true });

        let result: string;
        try {
          result = await withRetries(
            () => {
              // Render inside the retry: a failing template shell/@spill tag
              // (e.g. a flaky `gh issue list`) is retried with backoff instead
              // of crashing the loop — and a hard failure surfaces as a terminal
              // stage failure rather than a degraded prompt that false-completes.
              const prompt = renderTemplate(
                templatePath,
                { INPUTS: inputs },
                { cwd: workspaceDir, spillHostDir, spillRefPath }
              );
              return runStage(
                stage,
                prompt,
                workspaceDir,
                i,
                spillHostDir,
                stageLog,
                { signal: stageAbort.signal }
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
