import { spawnSync } from "node:child_process";
import { changedPaths, needsChecks } from "./check-changes.mjs";

// The installed shim preserves every ref; direct `prek run` supplies one range.
const from = process.env.PRE_COMMIT_FROM_REF;
const to = process.env.PRE_COMMIT_TO_REF;
const records = process.env.RALPH_PUSH_REFS;
const ranges = records
  ? records
      .trim()
      .split(/\r?\n/)
      .map((line) => {
        const fields = line.trim().split(/\s+/);
        if (
          fields.length !== 4 ||
          !/^[0-9a-f]{40,64}$/.test(fields[1]) ||
          !/^[0-9a-f]{40,64}$/.test(fields[3])
        )
          throw new Error("Invalid pre-push ref record");
        return [fields[3], fields[1]];
      })
      .filter(([, head]) => !/^0+$/.test(head))
  : [[from, to]];
if (!ranges.some(([base, head]) => needsChecks(changedPaths(base, head)))) {
  console.log("[skipped] verification: documentation-only range");
  process.exit(0);
}

const checks = [
  ...ranges.map(([base, head]) => [
    "whitespace",
    "git",
    [
      "diff",
      "--check",
      ...(base && head && !/^0+$/.test(base) ? [base, head, "--"] : []),
    ],
  ]),
  ["typecheck", "pnpm", ["-r", "typecheck"]],
  ["build", "pnpm", ["-r", "build"]],
  ["workspace tests", "pnpm", ["-r", "test"]],
  ["root tests", "pnpm", ["test"]],
];

for (let i = 0; i < checks.length; i++) {
  const [name, command, args] = checks[i];
  console.log(`[pending] ${name}`);
  // pnpm is a .cmd shim on Windows. Only the fixed commands above enter the shell.
  const windowsPnpm = process.platform === "win32" && command === "pnpm";
  const result = spawnSync(windowsPnpm ? "pnpm.cmd" : command, args, {
    stdio: "inherit",
    windowsHide: true,
    shell: windowsPnpm,
  });
  const code = result.status ?? 1;
  console.log(`[${code === 0 ? "passed" : "failed"}] ${name}`);
  if (code !== 0) {
    if (result.error) console.error(result.error.message);
    for (const [remaining] of checks.slice(i + 1))
      console.log(`[skipped] ${remaining}: earlier check failed`);
    process.exit(code);
  }
}
