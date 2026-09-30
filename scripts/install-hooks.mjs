import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";

if (process.env.CI === "true" || process.env.CI === "1") {
  console.log("[skipped] Git hook installation in CI");
  process.exit(0);
}

const options = { encoding: "utf8", windowsHide: true };
const probe = spawnSync("prek", ["--version"], options);
if (probe.status !== 0) {
  console.error(
    "Install prek on PATH, then run pnpm hooks:install: https://prek.j178.dev/installation/"
  );
  process.exit(process.argv.includes("--if-available") ? 0 : 1);
}

// Migrate only this project's former Husky setting. Leave other hooksPath values
// to prek's own installer, which honors in-repository custom hook directories.
const previous = spawnSync(
  "git",
  ["config", "--local", "--get", "core.hooksPath"],
  options
).stdout?.trim();
if (
  previous &&
  [".husky", ".husky/_"].some((path) => resolve(previous) === resolve(path))
) {
  execFileSync(
    "git",
    ["config", "--local", "--unset", "core.hooksPath"],
    options
  );
}
const result = spawnSync("prek", ["install"], {
  stdio: "inherit",
  windowsHide: true,
});
process.exitCode = result.status ?? 1;
if (process.exitCode === 0) {
  const hookPath = execFileSync(
    "git",
    ["rev-parse", "--git-path", "hooks/pre-push"],
    options
  ).trim();
  const shim = readFileSync(hookPath, "utf8");
  // Keep prek's generated header, executable mode, binary fallback and legacy
  // hook handling; replace only its final invocation to collect every ref.
  const invocation = /^exec "\$PREK" hook-impl.*$/m;
  if (!invocation.test(shim))
    throw new Error(
      "Unrecognized prek pre-push shim; cannot preserve pushed refs"
    );
  writeFileSync(
    hookPath,
    shim.replace(
      invocation,
      'exec node "$(git rev-parse --show-toplevel)/scripts/prek-pre-push.mjs" "$PREK" "$HERE" "$@"'
    )
  );
}
