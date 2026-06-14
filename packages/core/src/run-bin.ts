import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseFlags,
  printConfig,
  printHelp,
  printVersion,
} from "./cli-help.js";
import { detachAndExit } from "./detach.js";
import { runLoop } from "./loop.js";
import type { Stage } from "./stages.js";

export type RunBinConfig = {
  /** Bin name for usage/version/config output (e.g. "ralph-afk"). */
  bin: string;
  /** Positional-arg usage string (e.g. "<plan-and-prd> <iterations>"). */
  usage: string;
  /** One-line description for --help. */
  desc: string;
  /** Stage chain; first stage is the gate. */
  stages: [Stage, ...Stage[]];
  /**
   * Whether the bin takes a leading input positional before <iterations>.
   * `true`  → argv is `<inputs> <iterations>` (ralph-afk; inputs = rest[0]).
   * `false` → argv is `<iterations>`          (ralph-ghafk; inputs = "").
   */
  takesInputArg: boolean;
  cliVersion?: string;
  /** Whether this bin supports --watch. Only ralph-ghafk sets this. */
  supportsWatch?: boolean;
};

/**
 * Shared entry for the AFK bins: parse flags, handle --version/--help/--print-config,
 * resolve the workspace / package dirs, validate the positional args,
 * optionally fork into the background (--detach), then drive runLoop.
 */
export async function runBin(argv: string[], cfg: RunBinConfig): Promise<void> {
  const flags = parseFlags(argv);

  if (flags.version) {
    printVersion(cfg.bin, cfg.cliVersion);
    return;
  }
  if (flags.help) {
    printHelp(cfg.bin, cfg.usage, cfg.desc);
    return;
  }

  // run-bin.js ships in the same dist/ dir as the bin entrypoints, so ".." is
  // the installed @daonhan/ralph-core package dir (which holds templates/).
  const here = dirname(fileURLToPath(import.meta.url));
  const packageDir = resolve(here, "..");
  const workspaceDir = resolve(process.env.RALPH_WORKSPACE ?? process.cwd());

  const detachLogPath = flags.detach
    ? (flags.log ??
      join(workspaceDir, ".ralph-tmp", "logs", `detached-${process.pid}.log`))
    : undefined;

  const DEFAULT_LENSES = ["correctness", "security", "tests"];
  const envLenses = (process.env.RALPH_REVIEW_LENSES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const reviewLenses =
    envLenses.length > 0
      ? envLenses
      : flags.reviewPanel
        ? DEFAULT_LENSES
        : undefined;

  if (flags.printConfig) {
    printConfig(cfg.bin, workspaceDir, packageDir, {
      cliVersion: cfg.cliVersion,
      noKeepAlive: flags.noKeepAlive,
      maxRetries: flags.maxRetries,
      detach: flags.detach,
      detachLogPath,
      notify: flags.notify,
      budget: flags.budget,
      cooldownMs: flags.cooldownMs,
      reviewLenses: reviewLenses ?? [],
      watch: flags.watch,
      watchIntervalSec: flags.watchIntervalSec,
    });
    return;
  }

  const inputs = cfg.takesInputArg ? flags.rest[0] : "";
  const iterationsArg = cfg.takesInputArg ? flags.rest[1] : flags.rest[0];
  if ((cfg.takesInputArg && !inputs) || !iterationsArg) {
    console.error(`Usage: ${cfg.bin} ${cfg.usage}`);
    console.error(`       ${cfg.bin} --help`);
    process.exit(1);
  }
  const iterations = Number.parseInt(iterationsArg, 10);
  if (!Number.isFinite(iterations) || iterations < 1) {
    console.error(`Invalid iterations: ${iterationsArg}`);
    process.exit(1);
  }

  if (flags.detach && detachLogPath) {
    detachAndExit({
      logPath: detachLogPath,
      argv,
      binEntry: process.argv[1],
    });
  }

  if (flags.watch) {
    if (!cfg.supportsWatch) {
      console.error("--watch is only supported by ralph-ghafk");
      process.exit(1);
    }
    const { runWatch } = await import("./watch.js");
    await runWatch({
      stages: cfg.stages,
      iterations,
      workspaceDir,
      packageDir,
      watchIntervalSec: flags.watchIntervalSec ?? 300,
      watchLabel: process.env.RALPH_WATCH_LABEL?.trim() || "ralph",
      budgetUsd: flags.budget,
      cooldownMs: flags.cooldownMs,
      notify: flags.notify,
      bin: cfg.bin,
      cliVersion: cfg.cliVersion,
    });
    return;
  }

  await runLoop({
    stages: cfg.stages,
    inputs: inputs ?? "",
    iterations,
    workspaceDir,
    packageDir,
    noKeepAlive: flags.noKeepAlive,
    maxRetries: flags.maxRetries,
    notify: flags.notify,
    bin: cfg.bin,
    cliVersion: cfg.cliVersion,
    budgetUsd: flags.budget,
    cooldownMs: flags.cooldownMs,
    reviewLenses,
  });
}
