import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

// SECURITY INVARIANT: the command bodies of the !`cmd`, !?`cmd`, and @spill tags
// are executed on the HOST shell (see execSync calls below). Templates are trusted
// (shipped in the npm tarball) and only ever embed STATIC command strings; {{ INPUTS }}
// is substituted LAST, into the already-expanded text, and is never re-shelled. Never
// author a tag whose command body interpolates runtime or untrusted data (issue bodies,
// commit messages, INPUTS, branch names) — that would be direct host RCE. See SECURITY.md.

// Order matters: !?`...` (try-shell w/ ||| fallback) must match before plain !`...`.
const SHELL_TRY_TAG = /!\?`([^`]+)`/g;
const SHELL_TAG = /!`([^`]+)`/g;
const INCLUDE_TAG = /@include:([^\s`)]+)/g;
// @spill[?]:<name>=`cmd[|||fallback]` — runs cmd, writes output to spillHostDir/<name>,
// substitutes the container-relative file path in the prompt. The `?` form treats
// non-zero exits as success and writes the fallback string instead of throwing.
const SPILL_TAG = /@spill(\??):([^\s=]+)=`([^`]+)`/g;
const GENERIC_TAG = /\{\{\s*([A-Z0-9_]+)\s*\}\}/g;
const TRY_SEP = "|||";
// Cap on captured stdout for every shell/@spill tag (64 MiB). Large outputs are
// meant to go through @spill (written to a file), not be inlined into the prompt.
const SPILL_MAX_BUFFER = 64 * 1024 * 1024;

export type RenderVars = Record<string, string>;

export type RenderOptions = {
  cwd?: string;
  // Where @spill writes files on the host. Required if templates use @spill.
  spillHostDir?: string;
  // POSIX path the agent uses to reach spillHostDir from its working dir.
  spillRefPath?: string;
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

  const afterSpill = afterInclude.replace(
    SPILL_TAG,
    (_match, q: string, name: string, body: string) => {
      if (!opts.spillHostDir || !opts.spillRefPath) {
        throw new Error(
          `@spill:${name} used but spillHostDir/spillRefPath not provided to renderTemplate`
        );
      }
      // Reject any name that could escape spillHostDir. Templates are trusted
      // (shipped in the npm tarball) but defense-in-depth — keep file writes
      // confined to the per-iteration spill dir.
      if (
        name.includes("/") ||
        name.includes("\\") ||
        name === "." ||
        name === ".." ||
        name.includes("..") ||
        isAbsolute(name)
      ) {
        throw new Error(
          `@spill:${name} — name must be a plain filename (no path separators, no ..)`
        );
      }
      const tryMode = q === "?";
      let cmd = body;
      let fallback = "";
      if (tryMode) {
        const sep = body.lastIndexOf(TRY_SEP);
        if (sep >= 0) {
          cmd = body.slice(0, sep);
          fallback = body.slice(sep + TRY_SEP.length);
        }
      }
      let out: string;
      try {
        out = execSync(cmd, {
          shell,
          encoding: "utf8",
          maxBuffer: SPILL_MAX_BUFFER,
          cwd: opts.cwd,
          stdio: ["ignore", "pipe", tryMode ? "ignore" : "pipe"],
        });
      } catch (err) {
        if (!tryMode) throw err;
        out = fallback;
      }
      mkdirSync(opts.spillHostDir, { recursive: true });
      writeFileSync(join(opts.spillHostDir, name), out, "utf8");
      return `./${opts.spillRefPath}/${name}`;
    }
  );

  const afterShellTry = afterSpill.replace(
    SHELL_TRY_TAG,
    (_match, body: string) => {
      const sep = body.lastIndexOf(TRY_SEP);
      const cmd = sep >= 0 ? body.slice(0, sep) : body;
      const fallback = sep >= 0 ? body.slice(sep + TRY_SEP.length) : "";
      try {
        const out = execSync(cmd, {
          shell,
          encoding: "utf8",
          maxBuffer: SPILL_MAX_BUFFER,
          cwd: opts.cwd,
          stdio: ["ignore", "pipe", "ignore"],
        });
        return out.replace(/\r?\n$/, "");
      } catch {
        return fallback;
      }
    }
  );

  const afterShell = afterShellTry.replace(SHELL_TAG, (_match, cmd: string) => {
    const out = execSync(cmd, {
      shell,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      cwd: opts.cwd,
    });
    return out.replace(/\r?\n$/, "");
  });
  // SECURITY: generic substitution is the last pass and never re-shelled.
  // INPUTS, LENS, FINDINGS_DIR, etc. are harness constants — no new injection surface.
  // Unknown {{ TAG }} are left untouched.
  return afterShell.replace(GENERIC_TAG, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : match
  );
}
