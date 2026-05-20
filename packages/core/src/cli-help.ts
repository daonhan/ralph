import { existsSync } from "node:fs";
import { join } from "node:path";

import { IMAGE_REF } from "./runner.js";

export type CliFlags = { help: boolean; printConfig: boolean; rest: string[] };

export function parseFlags(argv: string[]): CliFlags {
  let help = false;
  let printConfig = false;
  const rest: string[] = [];
  for (const a of argv) {
    if (a === "-h" || a === "--help") help = true;
    else if (a === "--print-config") printConfig = true;
    else rest.push(a);
  }
  return { help, printConfig, rest };
}

export function printHelp(bin: string, usage: string, description: string): void {
  process.stdout.write(`${bin} — ${description}

Usage:
  ${bin} ${usage}
  ${bin} --help | -h
  ${bin} --print-config [args...]

Flags:
  -h, --help          show this help and exit
  --print-config      resolve workspace / docker context / image, print, exit without launching docker

Environment variables:
  RALPH_WORKSPACE       host dir bind-mounted at /home/agent/workspace (default: cwd)
  RALPH_DOCKER_CONTEXT  docker build fallback context (default: bundled @daonhan/ralph-core dir)
  RALPH_IMAGE           image ref (default: docker.io/daonhan/ralph-sandbox:latest)
  RALPH_IMAGE_TAG       legacy alias for RALPH_IMAGE

Image resolution: docker image inspect → docker pull → docker build (fallback).
Build fallback runs only if pull fails AND $RALPH_DOCKER_CONTEXT/Dockerfile exists; expect ~5min.
`);
}

export function printConfig(
  bin: string,
  workspaceDir: string,
  ralphDir: string,
  sandcastleDir: string
): void {
  const dockerfile = join(ralphDir, "Dockerfile");
  const dfPresent = existsSync(dockerfile);
  process.stdout.write(`[${bin}] resolved config
  RALPH_WORKSPACE       ${workspaceDir}${process.env.RALPH_WORKSPACE ? "" : "  (default: cwd)"}
  RALPH_DOCKER_CONTEXT  ${ralphDir}${process.env.RALPH_DOCKER_CONTEXT ? "" : "  (default: bundled core dir)"}
  RALPH_IMAGE           ${IMAGE_REF}${process.env.RALPH_IMAGE || process.env.RALPH_IMAGE_TAG ? "" : "  (default)"}
  Dockerfile at ctx     ${dfPresent ? "present" : "MISSING"} (${dockerfile})
  sandcastleDir         ${sandcastleDir}
`);
}
