// Contract test for release-please-config.json path scoping.
//
// A full `release-please --dry-run` needs GitHub API access (token + network),
// so it is not suitable for offline CI. This test is the programmatic equivalent:
// it loads the REAL release-please-config.json and reproduces release-please's own
// commit-attribution semantics — `CommitSplit` (assign each changed file to the
// package with the longest matching directory prefix) followed by `CommitExclude`
// (drop a package from a commit when every file relevant to that package is matched
// by one of its `exclude-paths`). It then asserts which component(s) a synthetic
// commit would bump. This catches config drift (wrong path, wrong component name,
// missing exclude) at PR time, which is exactly where the synthetic `ralph-sandbox`
// component is most likely to break.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(
  readFileSync(join(ROOT, "release-please-config.json"), "utf8")
);
const manifest = JSON.parse(
  readFileSync(join(ROOT, ".release-please-manifest.json"), "utf8")
);

const ROOT_PATH = ".";
const isRelevant = (file, path) =>
  path === ROOT_PATH || file === path || file.indexOf(`${path}/`) === 0;

/**
 * Given the set of files a single commit touches, return the set of component
 * names that release-please would bump, per the configured packages + exclude-paths.
 */
function bumpedComponents(files) {
  const packagePaths = Object.keys(config.packages);
  // CommitSplit: longest path first, assign each file to exactly one package.
  const sorted = packagePaths
    .filter((p) => p !== ROOT_PATH)
    .sort((a, b) => b.length - a.length);
  const assigned = new Set();
  for (const f of files) {
    if (!f.includes("/")) continue; // top-level files are not attributed
    const pkg = sorted.find((p) => f.indexOf(`${p}/`) === 0);
    if (pkg) assigned.add(pkg);
  }
  // CommitExclude: keep the commit for a package unless every relevant file is excluded.
  const bumped = new Set();
  for (const p of assigned) {
    const excludePaths = config.packages[p]["exclude-paths"] || [];
    const relevant = files.filter((f) => isRelevant(f, p));
    const allExcluded =
      relevant.length > 0 &&
      relevant.every((f) => excludePaths.some((e) => isRelevant(f, e)));
    if (!allExcluded) bumped.add(config.packages[p].component);
  }
  return bumped;
}

const expectOnly = (files, component) => {
  const got = bumpedComponents(files);
  assert.ok(
    got.has(component),
    `expected ${component} to bump for ${JSON.stringify(files)}, got ${[...got].join(", ") || "(none)"}`
  );
  for (const other of ["ralph-core", "ralph", "ralph-sandbox"]) {
    if (other === component) continue;
    assert.ok(
      !got.has(other),
      `expected ${other} NOT to bump for ${JSON.stringify(files)}, but it did (drift: ${component} vs ${other})`
    );
  }
};

test("config declares the three expected components", () => {
  const components = Object.values(config.packages).map((p) => p.component);
  assert.deepEqual(
    new Set(components),
    new Set(["ralph-core", "ralph", "ralph-sandbox"])
  );
  assert.deepEqual(
    new Set(Object.keys(config.packages)),
    new Set(Object.keys(manifest))
  );
});

test("feat touching only packages/core/src/** bumps ralph-core, not ralph-sandbox", () => {
  expectOnly(["packages/core/src/loop.ts"], "ralph-core");
  expectOnly(
    ["packages/core/src/runner.ts", "packages/core/package.json"],
    "ralph-core"
  );
});

test("component changelog-only changes do not trigger release PRs", () => {
  const got = bumpedComponents([
    "packages/core/CHANGELOG.md",
    "apps/cli/CHANGELOG.md",
  ]);
  assert.equal(
    got.size,
    0,
    `expected changelog-only repair changes not to bump components, got ${[...got].join(", ") || "(none)"}`
  );
});

test("change touching only packages/core/templates/Dockerfile bumps ralph-sandbox, not ralph-core", () => {
  expectOnly(["packages/core/templates/Dockerfile"], "ralph-sandbox");
});

test("change touching packages/core/templates/** (playbooks) bumps ralph-sandbox only", () => {
  expectOnly(["packages/core/templates/prompt.md"], "ralph-sandbox");
});

test("feat touching only apps/cli/** bumps ralph, not the others", () => {
  expectOnly(["apps/cli/bin/ralph-afk.js"], "ralph");
});
