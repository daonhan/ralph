import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseSmokeArgs, runImageSmoke } from "./smoke-image.mjs";

const SCRIPT = fileURLToPath(new URL("./smoke-image.mjs", import.meta.url));
const PREBUILT_ARGS = ["--image", "sandbox:test"];

function successfulResult(args) {
  const entrypoint = args[args.indexOf("--entrypoint") + 1];
  return {
    status: 0,
    stdout:
      entrypoint === "id"
        ? "agent\n"
        : entrypoint === "python" || entrypoint === "python3"
          ? "Python 3.11.2\n"
          : "",
    stderr: "",
  };
}

function executeSmoke(args, resultFor = successfulResult) {
  const calls = [];
  const logs = [];
  runImageSmoke(parseSmokeArgs(args, {}), {
    run(command, commandArgs) {
      calls.push([command, commandArgs]);
      return resultFor(commandArgs, calls.length - 1);
    },
    log(message) {
      logs.push(message);
    },
  });
  return { calls, logs };
}

test("uses the documented Dockerfile and root context by default", () => {
  assert.deepEqual(parseSmokeArgs([], {}), {
    image: "ralph-sandbox:smoke",
    build: true,
    skipNetwork: false,
  });
});

test("accepts a prebuilt image without scheduling a build", () => {
  assert.deepEqual(parseSmokeArgs(["--image", "example/sandbox:test"], {}), {
    image: "example/sandbox:test",
    build: false,
    skipNetwork: false,
  });
});

test("accepts a prebuilt image from RALPH_SMOKE_IMAGE", () => {
  assert.deepEqual(
    parseSmokeArgs([], { RALPH_SMOKE_IMAGE: "env-image:test" }),
    {
      image: "env-image:test",
      build: false,
      skipNetwork: false,
    }
  );
});

test("accepts explicit flag and env forms for skipping the network check", () => {
  assert.equal(parseSmokeArgs(["--skip-network"], {}).skipNetwork, true);
  assert.equal(
    parseSmokeArgs([], { RALPH_SMOKE_SKIP_NETWORK: "1" }).skipNetwork,
    true
  );
});

test("rejects --image without a tag", () => {
  assert.throws(
    () => parseSmokeArgs(["--image"], {}),
    /--image requires an image tag/
  );
});

test("rejects --image when the next token is another flag", () => {
  assert.throws(
    () => parseSmokeArgs(["--image", "--skip-network"], {}),
    /--image requires an image tag/
  );
});

test("rejects unknown arguments", () => {
  assert.throws(
    () => parseSmokeArgs(["--surprise"], {}),
    /unknown argument: --surprise/
  );
});

test("build mode uses the documented Dockerfile and root context", () => {
  const { calls } = executeSmoke([]);

  assert.deepEqual(calls[0], [
    "docker",
    [
      "build",
      "--tag",
      "ralph-sandbox:smoke",
      "--file",
      "packages/core/templates/Dockerfile",
      ".",
    ],
  ]);
});

test("reports a failed image build in plain language", () => {
  assert.throws(
    () =>
      runImageSmoke(parseSmokeArgs([], {}), {
        run() {
          return { status: 17, stdout: "", stderr: "build exploded" };
        },
        log() {},
      }),
    /sandbox image build failed.*build exploded/
  );
});

test("prebuilt mode runs every Python image contract from outside the container", () => {
  const { calls } = executeSmoke(PREBUILT_ARGS);

  assert.deepEqual(calls.slice(0, 3), [
    ["docker", ["run", "--rm", "--entrypoint", "id", "sandbox:test", "-un"]],
    [
      "docker",
      ["run", "--rm", "--entrypoint", "python", "sandbox:test", "--version"],
    ],
    [
      "docker",
      ["run", "--rm", "--entrypoint", "python3", "sandbox:test", "--version"],
    ],
  ]);
  assert.equal(calls.length, 7);
  assert.match(calls[3][1].at(-1), /python -m venv/);
  assert.match(calls[4][1].at(-1), /bin\/python" -m pip --version/);
  assert.deepEqual(calls[5], [
    "docker",
    ["run", "--rm", "--entrypoint", "uv", "sandbox:test", "--version"],
  ]);
  assert.match(calls[6][1].at(-1), /uv pip install/);
  assert.match(calls[6][1].at(-1), /six==1\.17\.0/);
});

test("each failed check names the broken image contract", () => {
  const labels = [
    "default container user is agent",
    "python resolves to Python 3",
    "python3 is available",
    "python -m venv creates a virtual environment",
    "pip is available inside a virtual environment",
    "uv is available",
    "uv installs a pure-Python package from PyPI (network)",
  ];

  for (const [failedIndex, label] of labels.entries()) {
    assert.throws(
      () =>
        executeSmoke(PREBUILT_ARGS, (args, callIndex) => ({
          ...successfulResult(args),
          status: callIndex === failedIndex ? 1 : 0,
          stderr: callIndex === failedIndex ? "command exploded" : "",
        })),
      new RegExp(`image contract failed: ${label.replace(/[().]/g, "\\$&")}`)
    );
  }
});

test("rejects an image whose default user is not agent", () => {
  assert.throws(
    () =>
      executeSmoke(PREBUILT_ARGS, () => ({
        status: 0,
        stdout: "root\n",
        stderr: "",
      })),
    /default container user is agent.*got root/
  );
});

test("rejects a python command that is not Python 3", () => {
  assert.throws(
    () =>
      executeSmoke(PREBUILT_ARGS, (args) => ({
        ...successfulResult(args),
        stdout:
          args[args.indexOf("--entrypoint") + 1] === "python"
            ? "Python 2.7.18\n"
            : successfulResult(args).stdout,
      })),
    /python resolves to Python 3.*got Python 2\.7\.18/
  );
});

test("rejects a python3 command that is not Python 3", () => {
  assert.throws(
    () =>
      executeSmoke(PREBUILT_ARGS, (args) => ({
        ...successfulResult(args),
        stdout:
          args[args.indexOf("--entrypoint") + 1] === "python3"
            ? "unexpected runtime\n"
            : successfulResult(args).stdout,
      })),
    /python3 is available.*got unexpected runtime/
  );
});

test("reports when the network package-install check is skipped", () => {
  const { calls, logs } = executeSmoke([...PREBUILT_ARGS, "--skip-network"]);

  assert.equal(calls.length, 6);
  assert.match(logs.at(-1), /SKIP.*network package-install check/);
});

test("reports when the network package-install check runs", () => {
  const { logs } = executeSmoke(PREBUILT_ARGS);

  assert.ok(
    logs.some((message) => /RUN.*network package-install check/.test(message))
  );
});

test("does not report the network check as run when an earlier contract fails", () => {
  const logs = [];
  assert.throws(() => {
    runImageSmoke(parseSmokeArgs(PREBUILT_ARGS, {}), {
      run: () => ({ status: 1, stdout: "", stderr: "broken user" }),
      log: (message) => logs.push(message),
    });
  });

  assert.equal(
    logs.some((message) => /RUN.*network package-install check/.test(message)),
    false
  );
});

test("reports when Docker cannot be started", () => {
  assert.throws(
    () =>
      runImageSmoke(parseSmokeArgs([], {}), {
        run() {
          return {
            status: null,
            stdout: null,
            stderr: null,
            error: new Error("spawnSync docker ENOENT"),
          };
        },
        log() {},
      }),
    /sandbox image build failed.*spawnSync docker ENOENT/
  );
});

test("the real CLI reports invalid usage and returns non-zero", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "--surprise"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /image smoke failed: unknown argument: --surprise/
  );
});

test("the root package exposes the image smoke command", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8")
  );
  assert.equal(
    packageJson.scripts["smoke:image"],
    "node scripts/smoke-image.mjs"
  );
});
