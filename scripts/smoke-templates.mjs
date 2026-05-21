// Render the real shipped templates against this repo. Verifies @spill paths,
// inlined sections, and that prompts stay small.
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { renderTemplate } from "../packages/core/dist/render.js";

const repo = process.cwd();
const tplDir = join(repo, "packages", "core", "templates");

const cases = [
  { name: "afk.md", inputs: "tracer bullet: hello world" },
  { name: "ghafk.md", inputs: "" },
  { name: "review.md", inputs: "" },
];

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) process.stdout.write(`ok    ${name}\n`);
  else {
    process.stdout.write(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}\n`);
    failures++;
  }
};

for (const { name, inputs } of cases) {
  const work = mkdtempSync(
    join(tmpdir(), `ralph-smoke-${name.replace(".md", "")}-`)
  );
  const spillRel = `spill-test-${name}`;
  const spillHostDir = join(work, ".ralph-tmp", spillRel);
  const spillRefPath = posix.join(".ralph-tmp", spillRel);
  try {
    const out = renderTemplate(
      join(tplDir, name),
      { INPUTS: inputs },
      { cwd: repo, spillHostDir, spillRefPath }
    );
    const tokensApprox = Math.round(out.length / 4);
    process.stdout.write(
      `---- ${name} : ${out.length} chars (~${tokensApprox} tok)\n`
    );
    check(
      `${name}: under 20k tokens`,
      tokensApprox < 20000,
      `~${tokensApprox} tok`
    );

    if (name === "ghafk.md") {
      check(`${name}: has <issues-summary>`, out.includes("<issues-summary>"));
      check(
        `${name}: spill path inlined`,
        out.includes(`./${spillRefPath}/issues.json`)
      );
      check(
        `${name}: spill file exists`,
        existsSync(join(spillHostDir, "issues.json"))
      );
    }
    if (name === "review.md") {
      check(
        `${name}: spill path inlined`,
        out.includes(`./${spillRefPath}/head.diff`)
      );
      check(
        `${name}: spill file exists`,
        existsSync(join(spillHostDir, "head.diff"))
      );
      check(`${name}: includes REVIEWER`, out.includes("# REVIEWER"));
    }
    if (name === "afk.md") {
      check(
        `${name}: INPUTS substituted`,
        out.includes("tracer bullet: hello world")
      );
    }
  } catch (e) {
    check(`${name}: render did not throw`, false, String(e));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (failures) {
  process.stderr.write(`\n${failures} failure(s)\n`);
  process.exit(1);
}
process.stdout.write("\nall pass\n");
