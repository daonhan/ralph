import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderTemplate } from "../render.js";

describe("renderTemplate generic vars", () => {
  it("substitutes arbitrary {{ KEY }} vars and leaves unknown tags", () => {
    const dir = mkdtempSync(join(tmpdir(), "ralph-render-"));
    const tpl = join(dir, "t.md");
    writeFileSync(
      tpl,
      "lens={{ LENS }} in={{ INPUTS }} keep={{ UNKNOWN }}",
      "utf8"
    );
    const out = renderTemplate(tpl, { LENS: "security", INPUTS: "plan" });
    expect(out).toBe("lens=security in=plan keep={{ UNKNOWN }}");
    rmSync(dir, { recursive: true, force: true });
  });
});
