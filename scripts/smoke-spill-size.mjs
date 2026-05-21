// Verify heavy content actually lands in the spill file, not the prompt.
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { renderTemplate } from "../packages/core/dist/render.js";

const repo = process.cwd();
const tplDir = join(repo, "packages", "core", "templates");

const work = mkdtempSync(join(tmpdir(), "ralph-spill-size-"));
const spillRel = "spill-test";
const spillHostDir = join(work, ".ralph-tmp", spillRel);
const spillRefPath = posix.join(".ralph-tmp", spillRel);

renderTemplate(
  join(tplDir, "ghafk.md"),
  { INPUTS: "" },
  { cwd: repo, spillHostDir, spillRefPath }
);

const f = join(spillHostDir, "issues.json");
const size = statSync(f).size;
const body = readFileSync(f, "utf8");
process.stdout.write(`issues.json size: ${size} bytes\n`);
process.stdout.write(`first 200 chars: ${body.slice(0, 200)}\n`);

rmSync(work, { recursive: true, force: true });
