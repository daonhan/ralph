import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Use a narrow docs allowlist. Unknown paths and executable prose get checks.
export function needsChecks(paths) {
  return paths.some((path) => {
    if (/(^|\/)(AGENTS|CLAUDE|AGENT|SKILL)\.md$/i.test(path)) return true;
    if (
      /^packages\/core\/templates\//.test(path) ||
      /(^|\/)(skills|\.codex|\.claude|\.agents)\//.test(path)
    )
      return true;
    return !(
      /^[^/]+\.md$/i.test(path) ||
      /^docs\/.*\.(md|png|svg)$/i.test(path) ||
      /^(packages\/core|apps\/cli)\/(README|CHANGELOG)\.md$/.test(path) ||
      /^images\/pg17\/README\.md$/.test(path) ||
      /^\.github\/(PULL_REQUEST_TEMPLATE\.md|ISSUE_TEMPLATE\/[^/]+\.md)$/.test(
        path
      ) ||
      path === "LICENSE"
    );
  });
}

export function changedPaths(from, to, cwd = process.cwd()) {
  const git = (args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    })
      .split("\0")
      .filter(Boolean);
  // New branches or a manual --all-files run have no usable base: check the tree.
  if (!from || /^0+$/.test(from))
    return git(["ls-tree", "-r", "--name-only", "-z", to || "HEAD"]);
  if (!to) throw new Error("A changed range requires both refs");
  // Do not filter by existence or change type: deletions and both rename paths matter.
  return git(["diff", "--name-only", "--no-renames", "-z", from, to, "--"]);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [from, to] = process.argv.slice(2);
  if (!from || !to)
    throw new Error("Usage: node scripts/check-changes.mjs <base> <head>");
  console.log(`checks=${needsChecks(changedPaths(from, to))}`);
}
