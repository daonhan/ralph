import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { renderTemplate } from "../render.js";

const roots: string[] = [];

function template(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ralph-render-"));
  roots.push(dir);
  const path = join(dir, "t.md");
  writeFileSync(path, content, "utf8");
  return path;
}

afterEach(() => {
  while (roots.length > 0)
    rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("renderTemplate final-pass substitution", () => {
  it("replaces {{ INPUTS }} and {{ HISTORY }} independently", () => {
    const path = template("I={{ INPUTS }} H={{ HISTORY }}");
    expect(renderTemplate(path, { INPUTS: "plan", HISTORY: "hist" })).toBe(
      "I=plan H=hist"
    );
  });

  it("emits HISTORY verbatim — shell/spill tags in it are never executed", () => {
    const path = template("<history>\n{{ HISTORY }}\n</history>");
    // Agent-produced history can contain anything, including template tags and
    // regex-replacement specials ($&, $1). None must be expanded or re-shelled.
    const history =
      "prior work\n!`echo pwned`\n@spill:x=`echo nope`\nsee $& and $1 placeholders";

    const out = renderTemplate(path, { INPUTS: "", HISTORY: history });

    expect(out).toContain("!`echo pwned`");
    expect(out).toContain("@spill:x=`echo nope`");
    expect(out).toContain("see $& and $1 placeholders");
    expect(out).not.toContain("pwned\n");
  });
});
