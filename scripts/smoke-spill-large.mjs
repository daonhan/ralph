// Prove that a LARGE shell output lands in the spill file and the prompt
// only contains a short path reference (i.e. the cap-busting scenario is fixed).
import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { renderTemplate } from "../packages/core/dist/render.js";

const work = mkdtempSync(join(tmpdir(), "ralph-spill-large-"));
const tpl = join(work, "tpl.md");
const spillRel = "spill-X";
const spillHostDir = join(work, ".ralph-tmp", spillRel);
const spillRefPath = posix.join(".ralph-tmp", spillRel);

// 200_000 byte payload via `yes ... | head -c N` — portable on bash/git-bash.
writeFileSync(
  tpl,
  [
    "<pointer>",
    "@spill?:big.txt=`yes XXXXXXXX | head -c 200000|||fb`",
    "</pointer>",
  ].join("\n")
);

const out = renderTemplate(
  tpl,
  { INPUTS: "" },
  { cwd: work, spillHostDir, spillRefPath }
);

const spillSize = statSync(join(spillHostDir, "big.txt")).size;
const promptSize = out.length;

process.stdout.write(`prompt size: ${promptSize} chars\n`);
process.stdout.write(`spill size:  ${spillSize} bytes\n`);
process.stdout.write(`prompt body: ${JSON.stringify(out)}\n`);

const ok = promptSize < 200 && spillSize >= 199000;
process.stdout.write(
  ok ? "\nok: prompt tiny, spill carries load\n" : "\nFAIL\n"
);
rmSync(work, { recursive: true, force: true });
process.exit(ok ? 0 : 1);
