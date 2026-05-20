import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SHELL_TAG = /!`([^`]+)`/g;
const INPUTS_TAG = /\{\{\s*INPUTS\s*\}\}/g;

export type RenderVars = {
  INPUTS: string;
};

export type RenderOptions = {
  cwd?: string;
};

export function renderTemplate(
  templatePath: string,
  vars: RenderVars,
  opts: RenderOptions = {}
): string {
  const raw = readFileSync(templatePath, "utf8");
  const afterShell = raw.replace(SHELL_TAG, (_match, cmd: string) => {
    const out = execSync(cmd, {
      shell: process.platform === "win32" ? "cmd.exe" : "/bin/bash",
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      cwd: opts.cwd,
    });
    return out.replace(/\r?\n$/, "");
  });
  return afterShell.replace(INPUTS_TAG, vars.INPUTS);
}
