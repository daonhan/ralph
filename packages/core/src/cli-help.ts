import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseAgentName,
  resolveAgentTuning,
  validateAgentTuning,
  type AgentName,
  type AgentConfigSnapshot,
  type AgentSelectionSource,
  type AgentTuning,
} from "./agents/index.js";
import {
  CLAUDE_HOME_VOLUME,
  claudeUpdateEnabled,
  readHostClaudeModel,
  resolveClaudeModel,
  type HostClaudeModel,
} from "./agents/claude.js";
import { resolveHostHome } from "./agents/shared.js";
import {
  CODEX_CLI_VOLUME,
  codexUpdateEnabled,
  resolveCodexModel,
} from "./agents/codex.js";
import { DEFAULT_MAX_RETRIES } from "./retry.js";
import {
  IMAGE_REF,
  detectDockerSocketPath,
  resolveDockerSocketMount,
  resolveDockerfile,
} from "./runner.js";
import { isolationEnabled, resolveSandboxVolumes } from "./sandbox-volumes.js";

export type CliFlags = {
  help: boolean;
  version: boolean;
  printConfig: boolean;
  noKeepAlive: boolean;
  maxRetries?: number;
  detach: boolean;
  log?: string;
  notify: boolean;
  agent?: AgentName;
  codexUserConfig: boolean;
  model?: string;
  effort?: string;
  rest: string[];
};

export function parseFlags(argv: string[]): CliFlags {
  let help = false;
  let version = false;
  let printConfig = false;
  let noKeepAlive = false;
  let maxRetries: number | undefined;
  let expectingMaxRetries = false;
  let detach = false;
  let log: string | undefined;
  let expectingLog = false;
  let notify = false;
  let agent: AgentName | undefined;
  let expectingAgent = false;
  let codexUserConfig = false;
  let model: string | undefined;
  let expectingModel = false;
  let effort: string | undefined;
  let expectingEffort = false;
  const rest: string[] = [];
  for (const a of argv) {
    if (expectingAgent) {
      if (a.startsWith("-")) throw new Error("--agent requires a value");
      agent = parseAgentName(a);
      expectingAgent = false;
      continue;
    }
    if (expectingModel) {
      if (a.startsWith("-")) throw new Error("--model requires a value");
      model = a;
      expectingModel = false;
      continue;
    }
    if (expectingEffort) {
      if (a.startsWith("-")) throw new Error("--effort requires a value");
      effort = a;
      expectingEffort = false;
      continue;
    }
    if (expectingMaxRetries) {
      if (!/^\d+$/.test(a)) {
        throw new Error(
          `--max-retries must be a non-negative integer, got: ${JSON.stringify(a)}`
        );
      }
      maxRetries = Number.parseInt(a, 10);
      expectingMaxRetries = false;
      continue;
    }
    if (expectingLog) {
      log = a;
      expectingLog = false;
      continue;
    }
    if (a === "-h" || a === "--help") help = true;
    else if (a === "-V" || a === "--version") version = true;
    else if (a === "--print-config") printConfig = true;
    else if (a === "--no-keep-alive") noKeepAlive = true;
    else if (a === "--max-retries") expectingMaxRetries = true;
    else if (a === "--detach") detach = true;
    else if (a === "--log") expectingLog = true;
    else if (a === "--notify") notify = true;
    else if (a === "--agent") expectingAgent = true;
    else if (a === "--model") expectingModel = true;
    else if (a === "--effort") expectingEffort = true;
    else if (a === "--codex-user-config") codexUserConfig = true;
    else rest.push(a);
  }
  if (expectingAgent) {
    throw new Error("--agent requires a value");
  }
  if (expectingModel) {
    throw new Error("--model requires a value");
  }
  if (expectingEffort) {
    throw new Error("--effort requires a value");
  }
  if (expectingMaxRetries) {
    throw new Error("--max-retries requires a value");
  }
  if (expectingLog) {
    throw new Error("--log requires a value");
  }
  if (log !== undefined && !detach) {
    throw new Error("--log is only meaningful with --detach");
  }
  return {
    help,
    version,
    printConfig,
    noKeepAlive,
    maxRetries,
    detach,
    log,
    notify,
    agent,
    codexUserConfig,
    model,
    effort,
    rest,
  };
}

/**
 * Resolve the @daonhan/ralph-core version by reading the package.json that
 * sits two levels up from the compiled cli-help.js (packages/core/dist/ →
 * packages/core/package.json). Returns "?" if unreadable so version reporting
 * never crashes the bin.
 */
export function readCoreVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "?";
  } catch {
    return "?";
  }
}

export function printVersion(bin: string, cliVersion?: string): void {
  const core = readCoreVersion();
  const cli = cliVersion ?? "?";
  process.stdout.write(`${bin} ${cli} (core ${core})\n`);
}

export function printHelp(
  bin: string,
  usage: string,
  description: string
): void {
  process.stdout.write(`${bin} — ${description}

Usage:
  ${bin} ${usage}
  ${bin} --help | -h
  ${bin} --version | -V
  ${bin} --print-config [args...]

Flags:
  -h, --help          show this help and exit
  -V, --version       print bin + core version and exit
  --print-config      resolve workspace / docker context / image / docker socket, print, exit without launching docker
  --no-keep-alive     skip OS wake-lock acquisition (default: acquire system-sleep inhibitor for loop lifetime)
  --max-retries <N>   per-stage retry budget on transient failure (default: 3; 0 disables retries)
  --detach            fork the loop into a background process, print pid + log path, and exit (parent returns 0)
  --log <path>        override the detached log path (default: <workspace>/.ralph-tmp/logs/detached-<parent-pid>.log; requires --detach)
  --notify            emit OS notification + terminal bell on loop completion or unrecoverable failure (default: off)
  --agent <claude|codex> select the in-container coding agent (default: claude; overrides RALPH_AGENT)
  --codex-user-config    load ~/.codex/config.toml for Codex (default: isolated; requires Codex)
  --model <name>      model for the selected agent (overrides RALPH_<AGENT>_MODEL and RALPH_MODEL)
  --effort <level>    reasoning effort for the selected agent (Claude: low|medium|high|xhigh|max;
                      Codex adds none|minimal|ultra; Ultra support is model-dependent)

Environment variables:
  RALPH_WORKSPACE       host dir bind-mounted at /home/agent/workspace (default: cwd)
  RALPH_DOCKER_CONTEXT  docker build fallback context (default: bundled @daonhan/ralph-core dir)
  RALPH_IMAGE           image ref (default: docker.io/daonhan/ralph-sandbox:latest)
  RALPH_IMAGE_TAG       legacy alias for RALPH_IMAGE
  RALPH_DOCKER_SOCK     "0" disables host docker.sock bind-mount (default: on if a
                        socket is detected). Mounting lets Testcontainers inside the
                        sandbox spawn sibling containers on the host daemon. Grants
                        root-equivalent host access.
  RALPH_AGENT           fallback agent selection when --agent is absent
  RALPH_CLAUDE_MODEL    model for Claude runs; outranks RALPH_MODEL
  RALPH_CODEX_MODEL     model for Codex runs; outranks RALPH_MODEL
  RALPH_CLAUDE_EFFORT   reasoning effort for Claude runs; outranks RALPH_EFFORT
  RALPH_CODEX_EFFORT    reasoning effort for Codex runs; outranks RALPH_EFFORT
  RALPH_EFFORT          reasoning effort for whichever agent runs, so only a
                        level both accept is allowed; a provider-only level goes
                        in that provider's variable. An unknown level ends the
                        run before any container starts.
  RALPH_MODEL           model for whichever agent runs. Precedence for both
                        model and effort: --model / --effort, then
                        RALPH_<AGENT>_MODEL / _EFFORT, then RALPH_MODEL /
                        RALPH_EFFORT, then the agent default. Claude resolves
                        its model from that tuning, then the model pinned by host
                        ~/.claude/settings.json (env.ANTHROPIC_MODEL, else the
                        model key /model stored; its "(default)" entry stores
                        none), then claude-opus-5-5[1m] (Ralph default). Host
                        settings that enable CLAUDE_CODE_USE_BEDROCK / _VERTEX
                        / _FOUNDRY keep the container CLI's own resolution,
                        since those providers use their own model IDs. Isolated
                        Codex defaults to gpt-6-sol, and to high reasoning
                        whatever the model.
  RALPH_DOCKER_SOCK_PATH explicit docker.sock host path. When unset, auto-detected via
                        DOCKER_HOST (unix:// only), then a candidate list:
                          /var/run/docker.sock
                          $HOME/.docker/run/docker.sock  (Docker Desktop macOS 4.x+)
                          $HOME/.colima/default/docker.sock
                          $HOME/.rd/docker.sock          (Rancher Desktop)
                          $XDG_RUNTIME_DIR/docker.sock   (rootless Docker)
                          $XDG_RUNTIME_DIR/podman/podman.sock

Image resolution: docker image inspect → docker pull → docker build (fallback).
Build fallback runs only if pull fails AND $RALPH_DOCKER_CONTEXT/Dockerfile exists; expect ~5min.
`);
}

/** What the run actually resolved to, recorded in `run.started`. */
export type AgentConfigResolution = {
  /** Absent when the container CLI resolves the model itself. */
  model?: string;
  modelSource: string;
  /** Absent when the agent's own default applies. */
  effort?: string;
  effortSource: string;
};

export type AgentConfigDescription = {
  codexConfig?: string;
  model: string;
  reasoning: string;
  resolved: AgentConfigResolution;
};

type EffortDescription = { display: string; value?: string; source: string };

/**
 * Describe a tuned effort, invalid levels included: `--print-config` reports a
 * level the CLI would reject rather than throwing, since the printer is what a
 * user reaches for to find out which variable supplied it. The allowed list is
 * read back out of `validateAgentTuning`'s own message so the printer can never
 * name a different list than the check that ends the run.
 */
function describeTunedEffort(
  agent: AgentName,
  tuning: AgentTuning
): EffortDescription | undefined {
  const tuned = tuning.effort;
  if (!tuned) return undefined;
  const allowed = validateAgentTuning(agent, tuning)?.match(
    /expected one of ([^;]+)/
  )?.[1];
  const suffix = allowed ? `; invalid: allowed ${allowed}` : "";
  return {
    display: `${tuned.value} (${tuned.source}${suffix})`,
    value: tuned.value,
    source: tuned.source,
  };
}

export function describeAgentConfig(
  agent: AgentName,
  codexUserConfig: boolean,
  tuning: AgentTuning,
  hostClaudeModel?: HostClaudeModel
): AgentConfigDescription {
  if (agent === "claude") {
    const resolution = resolveClaudeModel(tuning.model?.value, hostClaudeModel);
    // Claude takes no effort default from Ralph: with none set, the CLI applies
    // whatever the host settings' effortLevel says.
    const effort = describeTunedEffort(agent, tuning) ?? {
      display: "Claude CLI default (host settings effortLevel applies)",
      source: "Claude CLI default",
    };
    // Both returns carry all four fields: a run.started with every one absent
    // is how a consumer detects a Ralph too old to have honored the request.
    if (!resolution.model) {
      return {
        model: `container CLI default (host settings enable ${hostClaudeModel?.providerFlag})`,
        reasoning: effort.display,
        resolved: {
          modelSource: resolution.modelSource,
          effort: effort.value,
          effortSource: effort.source,
        },
      };
    }
    const modelSource =
      resolution.modelSource === "host settings"
        ? "host ~/.claude/settings.json"
        : resolution.modelSource === "RALPH_MODEL"
          ? (tuning.model?.source ?? resolution.modelSource)
          : resolution.modelSource;
    const warning = hostClaudeModel?.unreadable
      ? `; host settings unreadable: ${hostClaudeModel.unreadable}`
      : "";
    return {
      model: `${resolution.model} (${modelSource}${warning})`,
      reasoning: effort.display,
      resolved: {
        model: resolution.model,
        modelSource,
        effort: effort.value,
        effortSource: effort.source,
      },
    };
  }

  const resolution = resolveCodexModel(
    tuning.model?.value,
    tuning.effort?.value,
    codexUserConfig
  );
  const modelSource =
    resolution.modelSource === "explicit"
      ? (tuning.model?.source ?? resolution.modelSource)
      : resolution.modelSource;
  const effort =
    describeTunedEffort(agent, tuning) ??
    (resolution.reasoningEffort
      ? {
          display: `${resolution.reasoningEffort} (${resolution.reasoningSource})`,
          value: resolution.reasoningEffort,
          source: resolution.reasoningSource,
        }
      : {
          display: resolution.reasoningSource,
          source: resolution.reasoningSource,
        });
  return {
    codexConfig: codexUserConfig
      ? "inherited (~/.codex/config.toml)"
      : "isolated (--ignore-user-config)",
    model: resolution.model
      ? `${resolution.model} (${modelSource})`
      : "user config (RALPH_MODEL unset)",
    reasoning: effort.display,
    resolved: {
      model: resolution.model,
      modelSource,
      effort: effort.value,
      effortSource: effort.source,
    },
  };
}

/**
 * Resolve the provider-owned part of one stage attempt synchronously. The loop
 * passes this same snapshot to the attempt banner and command construction so
 * mutable host settings cannot make the two disagree.
 */
export function resolveAgentConfigSnapshot(
  agent: AgentName,
  codexUserConfig: boolean,
  tuning: AgentTuning,
  home: string = resolveHostHome()
): AgentConfigSnapshot {
  const host = agent === "claude" ? readHostClaudeModel(home) : undefined;
  return {
    ...describeAgentConfig(agent, codexUserConfig, tuning, host).resolved,
    unreadableSettings: host?.unreadable,
  };
}

/** Escape terminal controls for display without changing the command value. */
function sanitizeConfigDisplay(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) => {
    switch (character) {
      case "\n":
        return "\\n";
      case "\r":
        return "\\r";
      case "\t":
        return "\\t";
      default:
        return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
    }
  });
}

function formatAttemptSetting(
  value: string | undefined,
  source: string
): string {
  const safeSource = sanitizeConfigDisplay(source);
  return value === undefined
    ? `provider-managed (${safeSource})`
    : `${sanitizeConfigDisplay(value)} (${safeSource})`;
}

/** One plain-text line that stays readable in terminals and redirected logs. */
export function formatAttemptConfig(
  attempt: number,
  agent: AgentName,
  snapshot: AgentConfigSnapshot
): string {
  return `attempt ${attempt} · ${agent} · configured model=${formatAttemptSetting(snapshot.model, snapshot.modelSource)} · effort=${formatAttemptSetting(snapshot.effort, snapshot.effortSource)}`;
}

export type PrintConfigOptions = {
  cliVersion?: string;
  noKeepAlive?: boolean;
  maxRetries?: number;
  detach?: boolean;
  detachLogPath?: string;
  notify?: boolean;
  agent?: AgentName;
  agentSource?: AgentSelectionSource;
  codexUserConfig?: boolean;
  /** `--model` / `--effort`, which outrank the env vars for this report too. */
  model?: string;
  effort?: string;
};

export function printConfig(
  bin: string,
  workspaceDir: string,
  ralphDir: string,
  packageDir: string,
  opts: PrintConfigOptions = {}
): void {
  const {
    cliVersion,
    noKeepAlive = false,
    maxRetries = DEFAULT_MAX_RETRIES,
    detach = false,
    detachLogPath,
    notify = false,
    agent = "claude",
    agentSource = "default",
    codexUserConfig = false,
    model,
    effort,
  } = opts;
  const dockerfile = resolveDockerfile(ralphDir);
  const dfPresent = existsSync(dockerfile);
  const core = readCoreVersion();
  const cli = cliVersion ?? "?";

  const sockOptOut = process.env.RALPH_DOCKER_SOCK === "0";
  const detectedSock = detectDockerSocketPath();
  const sockSource = process.env.RALPH_DOCKER_SOCK_PATH
    ? "RALPH_DOCKER_SOCK_PATH"
    : process.env.DOCKER_HOST?.startsWith("unix://")
      ? "DOCKER_HOST"
      : "auto-detected";
  const mountArgs = resolveDockerSocketMount();
  const groupAdd =
    mountArgs && mountArgs.includes("--group-add")
      ? mountArgs[mountArgs.indexOf("--group-add") + 1]
      : null;

  let sockStatus: string;
  if (sockOptOut) {
    sockStatus = "disabled (RALPH_DOCKER_SOCK=0)";
  } else if (!detectedSock) {
    sockStatus = "no socket found";
  } else {
    sockStatus = `mounting ${detectedSock} (${sockSource})${groupAdd ? `, --group-add ${groupAdd}` : ""}`;
  }

  // The store volume is the last entry of a non-empty list; the rest are the
  // per-package `node_modules` mounts this workspace gets.
  let nodeModulesStatus: string;
  if (isolationEnabled()) {
    const volumes = resolveSandboxVolumes(workspaceDir).length;
    nodeModulesStatus =
      volumes === 0
        ? "isolation on, but this workspace has no package.json — nothing mounted"
        : `isolated in ${volumes - 1} container volumes (RALPH_ISOLATE_NODE_MODULES=0 to share the host tree)`;
  } else if (process.env.RALPH_ISOLATE_NODE_MODULES?.trim() === "0") {
    nodeModulesStatus =
      "shared with the host bind mount (RALPH_ISOLATE_NODE_MODULES=0)";
  } else {
    nodeModulesStatus =
      "shared with the host bind mount (linux default; RALPH_ISOLATE_NODE_MODULES=1 to isolate)";
  }

  const claudeUpdateStatus = claudeUpdateEnabled()
    ? `on before every stage, cached in volume ${CLAUDE_HOME_VOLUME} (RALPH_CLAUDE_UPDATE=0 to run the image's copy)`
    : "off (RALPH_CLAUDE_UPDATE=0) — running the image's copy";
  const claudeUpdateLine =
    agent === "claude" ? `  claude update         ${claudeUpdateStatus}\n` : "";

  const codexUpdateStatus = codexUpdateEnabled()
    ? `on before every stage, cached in volume ${CODEX_CLI_VOLUME} (RALPH_CODEX_UPDATE=0 to run the image's copy)`
    : "off (RALPH_CODEX_UPDATE=0) — running the image's copy";
  const codexUpdateLine =
    agent === "codex" ? `  codex update          ${codexUpdateStatus}\n` : "";

  const keepAliveStatus = noKeepAlive ? "off" : "on (system sleep only)";
  const detachStatus =
    detach && detachLogPath ? `on (log: ${detachLogPath})` : "off";
  const notifyStatus = notify ? "on" : "off";
  const provider = describeAgentConfig(
    agent,
    codexUserConfig,
    resolveAgentTuning(agent, { model, effort }, process.env),
    agent === "claude" ? readHostClaudeModel(resolveHostHome()) : undefined
  );
  const providerLines = [
    `  agent                 ${agent} (${agentSource})`,
    ...(provider.codexConfig
      ? [`  codex config          ${provider.codexConfig}`]
      : []),
    `  model                 ${provider.model}`,
    `  reasoning             ${provider.reasoning}`,
  ].join("\n");

  process.stdout.write(`[${bin}] resolved config
  version               ${bin} ${cli} (core ${core})
  RALPH_WORKSPACE       ${workspaceDir}${process.env.RALPH_WORKSPACE ? "" : "  (default: cwd)"}
  RALPH_DOCKER_CONTEXT  ${ralphDir}${process.env.RALPH_DOCKER_CONTEXT ? "" : "  (default: bundled core dir)"}
  RALPH_IMAGE           ${IMAGE_REF}${process.env.RALPH_IMAGE || process.env.RALPH_IMAGE_TAG ? "" : "  (default)"}
  Dockerfile at ctx     ${dfPresent ? "present" : "MISSING"} (${dockerfile})
  packageDir            ${packageDir}
  history dir           ${join(workspaceDir, ".ralph", "history")}
${providerLines}
  RALPH_DOCKER_SOCK     ${sockStatus}
  node_modules          ${nodeModulesStatus}
${claudeUpdateLine}${codexUpdateLine}  keep-alive            ${keepAliveStatus}
  max-retries           ${maxRetries}
  detach                ${detachStatus}
  notify                ${notifyStatus}
`);
}
