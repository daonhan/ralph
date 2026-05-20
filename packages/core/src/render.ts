import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

// Order matters: !?`...` (try-shell w/ ||| fallback) must match before plain !`...`.
const SHELL_TRY_TAG = /!\?`([^`]+)`/g;
const SHELL_TAG = /!`([^`]+)`/g;
const INCLUDE_TAG = /@include:([^\s`)]+)/g;
const INPUTS_TAG = /\{\{\s*INPUTS\s*\}\}/g;
const TRY_SEP = "|||";

export type RenderVars = {
  INPUTS: string;
};

export type RenderOptions = {
  cwd?: string;
};

function resolveShell(): string {
  if (process.platform !== "win32") return "/bin/bash";
  // Prefer bash.exe (git-for-windows / WSL passthrough) for POSIX redirects + utils.
  const pathDirs = (process.env.PATH ?? "").split(";");
  for (const d of pathDirs) {
    if (!d) continue;
    const candidate = resolve(d, "bash.exe");
    if (existsSync(candidate)) return candidate;
  }
  return "cmd.exe";
}

export function renderTemplate(
  templatePath: string,
  vars: RenderVars,
  opts: RenderOptions = {}
): string {
  const raw = readFileSync(templatePath, "utf8");
  const templateDir = dirname(templatePath);
  const shell = resolveShell();

  const afterInclude = raw.replace(INCLUDE_TAG, (_match, rel: string) => {
    const target = isAbsolute(rel) ? rel : resolve(templateDir, rel);
    return readFileSync(target, "utf8").replace(/\r?\n$/, "");
  });

  const afterShellTry = afterInclude.replace(SHELL_TRY_TAG, (_match, body: string) => {
    const sep = body.lastIndexOf(TRY_SEP);
    const cmd = sep >= 0 ? body.slice(0, sep) : body;
    const fallback = sep >= 0 ? body.slice(sep + TRY_SEP.length) : "";
    try {
      const out = execSync(cmd, {
        shell,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        cwd: opts.cwd,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return out.replace(/\r?\n$/, "");
    } catch {
      return fallback;
    }
  });

  const afterShell = afterShellTry.replace(SHELL_TAG, (_match, cmd: string) => {
    const out = execSync(cmd, {
      shell,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      cwd: opts.cwd,
    });
    return out.replace(/\r?\n$/, "");
  });
  return afterShell.replace(INPUTS_TAG, vars.INPUTS);
}
