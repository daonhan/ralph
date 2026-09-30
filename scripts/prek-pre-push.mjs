import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

// prek currently exposes only the first pushed ref. Preserve all Git stdin
// records for our range checker, while letting prek run and report the hook.
const [prek, hookDir, ...args] = process.argv.slice(2);
const records = readFileSync(0, "utf8");
const result = spawnSync(
  prek,
  [
    "hook-impl",
    "--hook-dir",
    hookDir,
    "--script-version",
    "4",
    "--hook-type",
    "pre-push",
    "--",
    ...args,
  ],
  {
    input: records,
    stdio: ["pipe", "inherit", "inherit"],
    windowsHide: true,
    env: { ...process.env, RALPH_PUSH_REFS: records },
  }
);
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
