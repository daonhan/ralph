import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  IMAGE_REF,
  detectDockerSocketPath,
  resolveDockerSocketMount,
  resolveDockerfile,
} from "./runner.js";

export type CliFlags = {
  help: boolean;
  version: boolean;
  printConfig: boolean;
  rest: string[];
};

export function parseFlags(argv: string[]): CliFlags {
  let help = false;
  let version = false;
  let printConfig = false;
  const rest: string[] = [];
  for (const a of argv) {
    if (a === "-h" || a === "--help") help = true;
    else if (a === "-V" || a === "--version") version = true;
    else if (a === "--print-config") printConfig = true;
    else rest.push(a);
  }
  return { help, version, printConfig, rest };
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

Environment variables:
  RALPH_WORKSPACE       host dir bind-mounted at /home/agent/workspace (default: cwd)
  RALPH_DOCKER_CONTEXT  docker build fallback context (default: bundled @daonhan/ralph-core dir)
  RALPH_IMAGE           image ref (default: docker.io/daonhan/ralph-sandbox:latest)
  RALPH_IMAGE_TAG       legacy alias for RALPH_IMAGE
  RALPH_DOCKER_SOCK     "0" disables host docker.sock bind-mount (default: on if a
                        socket is detected). Mounting lets Testcontainers inside the
                        sandbox spawn sibling containers on the host daemon. Grants
                        root-equivalent host access.
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

export function printConfig(
  bin: string,
  workspaceDir: string,
  ralphDir: string,
  sandcastleDir: string,
  cliVersion?: string
): void {
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

  process.stdout.write(`[${bin}] resolved config
  version               ${bin} ${cli} (core ${core})
  RALPH_WORKSPACE       ${workspaceDir}${process.env.RALPH_WORKSPACE ? "" : "  (default: cwd)"}
  RALPH_DOCKER_CONTEXT  ${ralphDir}${process.env.RALPH_DOCKER_CONTEXT ? "" : "  (default: bundled core dir)"}
  RALPH_IMAGE           ${IMAGE_REF}${process.env.RALPH_IMAGE || process.env.RALPH_IMAGE_TAG ? "" : "  (default)"}
  Dockerfile at ctx     ${dfPresent ? "present" : "MISSING"} (${dockerfile})
  sandcastleDir         ${sandcastleDir}
  RALPH_DOCKER_SOCK     ${sockStatus}
`);
}
