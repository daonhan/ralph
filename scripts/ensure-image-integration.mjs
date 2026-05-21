// Integration check for ensureImage. Exercises the real `docker` CLI:
//   1. Floating ref + cached locally + reachable registry → re-pulls (verified
//      via stderr log line + non-error exit).
//   2. Floating ref + cached locally + unreachable registry → falls back to
//      cached copy without throwing.
//   3. Digest-pinned ref + cached locally → no pull attempted (no stderr log).
//
// Re-import the module per case with a different RALPH_IMAGE because IMAGE_REF
// is captured at module-load time.
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REAL_IMAGE = "docker.io/daonhan/ralph-sandbox:latest";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER_URL = pathToFileURL(
  join(HERE, "..", "packages", "core", "dist", "runner.js")
).href;

function run(env) {
  const code = `import(${JSON.stringify(RUNNER_URL)}).then((m) => { try { m.ensureImage(); console.log("OK"); } catch (e) { console.log("THROW:" + e.message); } });`;
  const r = spawnSync("node", ["--input-type=module", "-e", code], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status };
}

function ensurePrereq() {
  const inspect = spawnSync("docker", ["image", "inspect", REAL_IMAGE], {
    stdio: "ignore",
  });
  if (inspect.status !== 0) {
    const pull = spawnSync("docker", ["pull", REAL_IMAGE], {
      stdio: "inherit",
    });
    if (pull.status !== 0) throw new Error("prereq pull failed");
  }
}

function getDigest() {
  const r = spawnSync(
    "docker",
    ["image", "inspect", REAL_IMAGE, "--format", "{{index .RepoDigests 0}}"],
    { encoding: "utf8" }
  );
  if (r.status !== 0) throw new Error("inspect failed: " + r.stderr);
  return r.stdout.trim();
}

ensurePrereq();
const digestRef = getDigest();
console.log("[setup] digest ref =", digestRef);

// Case 1: floating + reachable → pull attempted, exits OK.
{
  const r = run({ RALPH_IMAGE: REAL_IMAGE });
  console.log("\n[case 1] floating + reachable");
  console.log("  stderr:", r.stderr.trim().split("\n").slice(0, 3).join(" | "));
  console.log("  stdout:", r.stdout.trim());
  assert.match(r.stderr, /Pulling image/, "should attempt pull for :latest");
  assert.match(r.stdout, /OK/, "should not throw");
  console.log("  PASS");
}

// Case 2: floating + unreachable registry → falls back to cached.
// Use a fake registry name nothing can resolve. We pre-tag the cached image
// under that name so hasLocal=true, then ensureImage should print the fallback
// message and exit OK.
{
  const FAKE = "localhost:1/ralph-fake:latest";
  spawnSync("docker", ["rmi", FAKE], { stdio: "ignore" });
  const tag = spawnSync("docker", ["tag", REAL_IMAGE, FAKE]);
  assert.equal(tag.status, 0, "docker tag should succeed");
  try {
    const r = run({ RALPH_IMAGE: FAKE });
    console.log("\n[case 2] floating + unreachable registry");
    console.log(
      "  stderr:",
      r.stderr.trim().split("\n").slice(0, 6).join(" | ")
    );
    console.log("  stdout:", r.stdout.trim());
    assert.match(r.stderr, /Pulling image/, "should attempt pull");
    assert.match(
      r.stderr,
      /using cached local copy/,
      "should announce cached-copy fallback"
    );
    assert.match(r.stdout, /OK/, "should not throw when local copy exists");
    console.log("  PASS");
  } finally {
    spawnSync("docker", ["rmi", FAKE], { stdio: "ignore" });
  }
}

// Case 3: digest-pinned + cached → no pull, no log line.
{
  const r = run({ RALPH_IMAGE: digestRef });
  console.log("\n[case 3] digest-pinned + cached");
  console.log("  stderr:", r.stderr.trim() || "(empty)");
  console.log("  stdout:", r.stdout.trim());
  assert.doesNotMatch(
    r.stderr,
    /Pulling image/,
    "must NOT pull for digest-pinned ref already cached"
  );
  assert.match(r.stdout, /OK/, "should not throw");
  console.log("  PASS");
}

console.log("\nAll 3 ensureImage integration cases passed.");
