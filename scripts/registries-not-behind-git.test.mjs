// Unit tests for the pure comparison core of registries-not-behind-git.mjs.
// Run via `pnpm test` (node --test). No git / npm / registry access required —
// the live lookups are injected by the script's edge, not exercised here.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findLaggingComponents,
  compareVersions,
} from "./registries-not-behind-git.mjs";

// Both npm components: tag == published. Nothing lags.
const IN_SYNC = {
  "ralph-core": { tag: "ralph-core-v0.6.3", published: "0.6.3" },
  ralph: { tag: "ralph-v0.6.3", published: "0.6.3" },
};

test("all in sync -> no lagging components", () => {
  assert.deepEqual(findLaggingComponents(IN_SYNC), []);
});

test("npm behind tag -> flagged", () => {
  const lagging = findLaggingComponents({
    ...IN_SYNC,
    ralph: { tag: "ralph-v0.6.3", published: "0.6.2" },
  });
  assert.deepEqual(lagging, [
    { component: "ralph", tag: "ralph-v0.6.3", published: "0.6.2" },
  ]);
});

test("registry ahead of tag -> not flagged", () => {
  const lagging = findLaggingComponents({
    ...IN_SYNC,
    "ralph-core": { tag: "ralph-core-v0.6.3", published: "0.6.4" },
  });
  assert.deepEqual(lagging, []);
});

test("component with no release tag cannot lag", () => {
  const lagging = findLaggingComponents({
    ralph: { tag: null, published: "0.6.2" },
  });
  assert.deepEqual(lagging, []);
});

test("tag with no published version is flagged as behind", () => {
  const lagging = findLaggingComponents({
    "ralph-core": { tag: "ralph-core-v0.6.3", published: null },
  });
  assert.deepEqual(lagging, [
    { component: "ralph-core", tag: "ralph-core-v0.6.3", published: null },
  ]);
});

test("multiple components can lag at once", () => {
  const lagging = findLaggingComponents({
    "ralph-core": { tag: "ralph-core-v0.6.3", published: "0.6.2" },
    ralph: { tag: "ralph-v0.6.3", published: "0.6.2" },
  });
  assert.deepEqual(
    lagging.map((l) => l.component),
    ["ralph-core", "ralph"]
  );
});

test("compareVersions orders by major.minor.patch, missing sorts lowest", () => {
  assert.equal(compareVersions("0.6.3", "0.6.2"), 1);
  assert.equal(compareVersions("0.6.2", "0.6.3"), -1);
  assert.equal(compareVersions("0.6.3", "0.6.3"), 0);
  assert.equal(compareVersions("1.0.0", "0.9.9"), 1);
  assert.equal(compareVersions("ralph-v0.6.3", "0.6.3"), 0);
  assert.equal(compareVersions("0.6.3", null), 1);
  assert.equal(compareVersions(null, null), 0);
});
