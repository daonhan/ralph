#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function parseSmokeArgs(args, env = process.env) {
  let imageArg = null;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--image") {
      const image = args[index + 1];
      if (!image || image.trim() === "" || image.startsWith("--")) {
        throw new Error("--image requires an image tag");
      }
      imageArg = image.trim();
      index++;
    } else if (args[index] !== "--skip-network") {
      throw new Error(`unknown argument: ${args[index]}`);
    }
  }
  const envImage = env.RALPH_SMOKE_IMAGE?.trim() || null;
  const prebuiltImage = imageArg ?? envImage;
  return {
    image: prebuiltImage ?? "ralph-sandbox:smoke",
    build: prebuiltImage === null,
    skipNetwork:
      args.includes("--skip-network") || env.RALPH_SMOKE_SKIP_NETWORK === "1",
  };
}

function failureDetail(result) {
  return (
    result.error?.message ||
    String(result.stderr ?? "").trim() ||
    `docker exited ${result.status}`
  );
}

export function runImageSmoke(options, { run, log }) {
  if (options.build) {
    log(`Building ${options.image} from packages/core/templates/Dockerfile...`);
    const result = run("docker", [
      "build",
      "--tag",
      options.image,
      "--file",
      "packages/core/templates/Dockerfile",
      ".",
    ]);
    if (result.status !== 0) {
      throw new Error(`sandbox image build failed: ${failureDetail(result)}`);
    }
  }

  const venvSetup =
    'tmp=$(mktemp -d); trap \'rm -rf "$tmp"\' 0; python -m venv "$tmp"';
  const checks = [
    {
      label: "default container user is agent",
      entrypoint: "id",
      args: ["-un"],
      validateOutput(output) {
        return output.trim() === "agent"
          ? null
          : `got ${output.trim() || "(empty)"}`;
      },
    },
    {
      label: "Codex CLI version is pinned",
      entrypoint: "codex",
      args: ["--version"],
      validateOutput(output) {
        return output.trim() === "codex-cli 0.144.4"
          ? null
          : `got ${output.trim() || "(empty)"}`;
      },
    },
    {
      label: "Codex exec exposes Ralph automation flags",
      entrypoint: "codex",
      args: ["exec", "--help"],
      validateOutput(output) {
        const required = [
          "--json",
          "--ephemeral",
          "--ignore-user-config",
          "--model",
          "--dangerously-bypass-approvals-and-sandbox",
        ];
        const options = new Set(output.match(/--[a-z0-9-]+/g) ?? []);
        const missing = required.filter((flag) => !options.has(flag));
        return missing.length === 0 ? null : `missing ${missing.join(", ")}`;
      },
    },
    {
      label: "python resolves to Python 3",
      entrypoint: "python",
      args: ["--version"],
      validateOutput(output) {
        return /^Python 3\./.test(output.trim())
          ? null
          : `got ${output.trim() || "(empty)"}`;
      },
    },
    {
      label: "python3 is available",
      entrypoint: "python3",
      args: ["--version"],
      validateOutput(output) {
        return /^Python 3\./.test(output.trim())
          ? null
          : `got ${output.trim() || "(empty)"}`;
      },
    },
    {
      label: "python -m venv creates a virtual environment",
      entrypoint: "sh",
      args: ["-c", `${venvSetup}; test -x \"$tmp/bin/python\"`],
    },
    {
      label: "pip is available inside a virtual environment",
      entrypoint: "sh",
      args: ["-c", `${venvSetup}; \"$tmp/bin/python\" -m pip --version`],
    },
    {
      label: "uv is available",
      entrypoint: "uv",
      args: ["--version"],
      validateOutput(output) {
        return /^uv \d+\.\d+\.\d+(?:\S*)?(?:\s|$)/.test(output.trim())
          ? null
          : `got ${output.trim() || "(empty)"}`;
      },
    },
    {
      label: "uvx is available",
      entrypoint: "uvx",
      args: ["--version"],
      validateOutput(output) {
        return /^uvx \d+\.\d+\.\d+(?:\S*)?(?:\s|$)/.test(output.trim())
          ? null
          : `got ${output.trim() || "(empty)"}`;
      },
    },
  ];
  if (!options.skipNetwork) {
    checks.push({
      label: "uv installs a pure-Python package from PyPI (network)",
      entrypoint: "sh",
      network: true,
      args: [
        "-c",
        `${venvSetup}; uv pip install --python \"$tmp/bin/python\" six==1.17.0; \"$tmp/bin/python\" -c 'import six; assert six.__version__ == \"1.17.0\"'`,
      ],
    });
  }

  for (const check of checks) {
    if (check.network) {
      log("RUN network package-install check (requires PyPI network access)");
    }
    const result = run("docker", [
      "run",
      "--rm",
      "--entrypoint",
      check.entrypoint,
      options.image,
      ...check.args,
    ]);
    if (result.status !== 0) {
      throw new Error(
        `image contract failed: ${check.label}: ${failureDetail(result)}`
      );
    }
    const outputError = check.validateOutput?.(result.stdout);
    if (outputError) {
      throw new Error(`image contract failed: ${check.label}: ${outputError}`);
    }
    log(`ok  ${check.label}`);
  }
  if (options.skipNetwork) {
    log("SKIP network package-install check (--skip-network)");
  }
}

function main() {
  const options = parseSmokeArgs(process.argv.slice(2));
  runImageSmoke(options, {
    run(command, args) {
      const isBuild = args[0] === "build";
      const result = spawnSync(command, args, {
        encoding: "utf8",
        stdio: isBuild ? "pipe" : undefined,
      });
      if (isBuild) {
        if (result.stdout) process.stdout.write(result.stdout);
        if (result.stderr) process.stderr.write(result.stderr);
      }
      return result;
    },
    log(message) {
      console.log(message);
    },
  });
  console.log(`All sandbox image contracts passed for ${options.image}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (error) {
    console.error(`image smoke failed: ${error.message}`);
    process.exitCode = 1;
  }
}
