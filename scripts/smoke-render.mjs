// Smoke test for render.ts @spill tag + existing tags.
// Run from repo root after `pnpm -r build`.
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { renderTemplate } from "../packages/core/dist/render.js";

const work = mkdtempSync(join(tmpdir(), "ralph-smoke-"));
const tpl = join(work, "tpl.md");
const incl = join(work, "incl.md");
const spillHostDir = join(work, ".ralph-tmp", "spill-test");
const spillRefPath = posix.join(".ralph-tmp", "spill-test");

writeFileSync(incl, "INCLUDED-CONTENT");
writeFileSync(
  tpl,
  [
    "<inputs>{{ INPUTS }}</inputs>",
    "<include>",
    "@include:incl.md",
    "</include>",
    "<shell>!?`echo HELLO|||FALLBACK`</shell>",
    "<shellfail>!?`this-cmd-does-not-exist|||FALLBACK`</shellfail>",
    '<spill>@spill?:big.json=`echo {\\"k\\":\\"v\\"}|||FB`</spill>',
    "<spillfail>@spill?:bad.json=`this-cmd-does-not-exist|||FB-FALLBACK`</spillfail>",
  ].join("\n")
);

let failures = 0;
const check = (name, cond, detail) => {
  if (cond) {
    process.stdout.write(`ok    ${name}\n`);
  } else {
    process.stdout.write(`FAIL  ${name}${detail ? `\n      ${detail}` : ""}\n`);
    failures++;
  }
};

const out = renderTemplate(
  tpl,
  { INPUTS: "INPUT-VAL" },
  { cwd: work, spillHostDir, spillRefPath }
);

check("INPUTS substituted", out.includes("<inputs>INPUT-VAL</inputs>"));
check("@include inlined", out.includes("INCLUDED-CONTENT"));
check("!? shell ok", /<shell>HELLO<\/shell>/.test(out));
check("!? shell fallback", /<shellfail>FALLBACK<\/shellfail>/.test(out));
check(
  "@spill ok → path inlined",
  out.includes(`<spill>./${spillRefPath}/big.json</spill>`)
);
check(
  "@spill fallback → path inlined",
  out.includes(`<spillfail>./${spillRefPath}/bad.json</spillfail>`)
);

const bigPath = join(spillHostDir, "big.json");
const badPath = join(spillHostDir, "bad.json");
check("@spill ok file exists", existsSync(bigPath));
check("@spill fallback file exists", existsSync(badPath));
if (existsSync(bigPath)) {
  const c = readFileSync(bigPath, "utf8");
  check(
    "@spill ok content",
    c.includes('"k":"v"'),
    `got: ${JSON.stringify(c)}`
  );
}
if (existsSync(badPath)) {
  const c = readFileSync(badPath, "utf8");
  check(
    "@spill fallback content",
    c === "FB-FALLBACK",
    `got: ${JSON.stringify(c)}`
  );
}

// Missing-opts guard.
try {
  renderTemplate(tpl, { INPUTS: "" }, { cwd: work });
  check("missing spill opts throws", false, "did not throw");
} catch (e) {
  check("missing spill opts throws", /spillHostDir/.test(String(e)));
}

// Path-traversal guard — names with separators / .. / absolute must be rejected.
const evilNames = [
  "../escape.txt",
  "..\\escape.txt",
  "sub/dir.txt",
  "/etc/passwd",
  "..",
];
for (const evil of evilNames) {
  const evilTpl = join(work, `evil-${encodeURIComponent(evil)}.md`);
  writeFileSync(evilTpl, `@spill?:${evil}=\`echo X|||fb\``);
  try {
    renderTemplate(
      evilTpl,
      { INPUTS: "" },
      { cwd: work, spillHostDir, spillRefPath }
    );
    check(`traversal rejected: ${evil}`, false, "did not throw");
  } catch (e) {
    check(
      `traversal rejected: ${evil}`,
      /plain filename/.test(String(e)),
      `wrong error: ${e}`
    );
  }
}

rmSync(work, { recursive: true, force: true });

if (failures > 0) {
  process.stderr.write(`\n${failures} failure(s)\n`);
  process.exit(1);
}
process.stdout.write("\nall pass\n");
