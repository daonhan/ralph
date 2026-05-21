// Unit test for runner.isFloatingRef — the predicate that decides whether
// ensureImage must `docker pull` to refresh a possibly-moved tag, or may
// short-circuit on a local copy because the ref is digest-pinned / version-pinned.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isFloatingRef } from "../packages/core/dist/runner.js";

test("untagged ref is floating", () => {
  assert.equal(isFloatingRef("docker.io/daonhan/ralph-sandbox"), true);
  assert.equal(isFloatingRef("ralph-sandbox"), true);
});

test(":latest is floating", () => {
  assert.equal(isFloatingRef("docker.io/daonhan/ralph-sandbox:latest"), true);
  assert.equal(isFloatingRef("ralph-sandbox:latest"), true);
});

test("semver tag is pinned", () => {
  assert.equal(isFloatingRef("docker.io/daonhan/ralph-sandbox:v0.1.1"), false);
  assert.equal(isFloatingRef("ralph-sandbox:1.2.3"), false);
});

test("digest ref is pinned (never floating, even with :latest)", () => {
  assert.equal(
    isFloatingRef("docker.io/daonhan/ralph-sandbox@sha256:" + "a".repeat(64)),
    false
  );
  assert.equal(
    isFloatingRef(
      "docker.io/daonhan/ralph-sandbox:latest@sha256:" + "b".repeat(64)
    ),
    false
  );
});

test("registry with explicit port does not confuse parser", () => {
  // host:5000/foo -> namePart "foo" -> no colon -> floating.
  assert.equal(isFloatingRef("registry.local:5000/ralph-sandbox"), true);
  // host:5000/foo:latest -> floating.
  assert.equal(isFloatingRef("registry.local:5000/ralph-sandbox:latest"), true);
  // host:5000/foo:1.0 -> pinned.
  assert.equal(isFloatingRef("registry.local:5000/ralph-sandbox:1.0"), false);
});
