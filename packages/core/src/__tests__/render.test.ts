import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { renderTemplate } from "../render.js";

vi.mock("node:child_process", () => ({ execSync: vi.fn() }));

const roots: string[] = [];

function template(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ralph-render-"));
  roots.push(dir);
  const path = join(dir, "t.md");
  writeFileSync(path, content, "utf8");
  return path;
}

afterEach(() => {
  vi.resetAllMocks();
  while (roots.length > 0)
    rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("shipped GitHub issue context", () => {
  function renderIssues(summary: string | Error, full: string | Error) {
    vi.mocked(execSync).mockImplementation((command) => {
      let result: string | Error;
      if (
        command ===
        "gh issue list --state open --limit 50 --json number,title,labels"
      ) {
        result = summary;
      } else if (
        command ===
        "gh issue list --state open --limit 50 --json number,title,body,labels,comments"
      ) {
        result = full;
      } else if (String(command).startsWith("git log ")) {
        result = "prior commit";
      } else {
        throw new Error(`Unexpected command: ${command}`);
      }
      if (result instanceof Error) throw result;
      return result;
    });
    const dir = mkdtempSync(join(tmpdir(), "ralph-issues-"));
    roots.push(dir);
    const out = renderTemplate(
      fileURLToPath(new URL("../../templates/ghafk.md", import.meta.url)),
      {
        INPUTS: "",
        HISTORY: "Prior run: no AFK-ready issues remain; closed #137.",
      },
      { cwd: dir, spillHostDir: dir, spillRefPath: ".ralph-tmp/test-spill" }
    );
    return {
      summary: JSON.parse(
        /<issues-summary>([\s\S]*?)<\/issues-summary>/.exec(out)![1]
      ),
      full: JSON.parse(readFileSync(join(dir, "issues.json"), "utf8")),
      out,
    };
  }

  it("renders a ready issue as JSON even when prior history says no tasks remain", () => {
    const result = renderIssues(
      '[{"number":137,"title":"Repair","labels":[{"name":"ready-for-agent"}]}]',
      '[{"number":137,"title":"Repair","labels":[{"name":"ready-for-agent"}],"body":"Reopened: acceptance still fails","comments":[{"body":"Windows verification is mandatory"}]}]'
    );
    expect(result.summary).toEqual([
      { number: 137, title: "Repair", labels: [{ name: "ready-for-agent" }] },
    ]);
    expect(result.full[0]).toMatchObject({
      number: 137,
      body: "Reopened: acceptance still fails",
      comments: [{ body: "Windows verification is mandatory" }],
    });
    expect(result.out).toContain("./.ralph-tmp/test-spill/issues.json");
  });

  it("preserves a successfully fetched empty queue", () => {
    const result = renderIssues("[]", "[]");
    expect(result.summary).toEqual([]);
    expect(result.full).toEqual([]);
  });

  it("preserves template syntax in issue titles without executing or substituting it", () => {
    const title =
      "Repair !`echo UNTRUSTED` !?`echo UNTRUSTED|||fallback` @spill:x=`echo UNTRUSTED` {{ INPUTS }} {{ HISTORY }}";
    const summary = JSON.stringify([{ number: 137, title, labels: [] }]);
    const result = renderIssues(summary, "[]");
    expect(result.summary[0].title).toBe(title);
    expect(vi.mocked(execSync).mock.calls.map(([command]) => command)).toEqual([
      "gh issue list --state open --limit 50 --json number,title,body,labels,comments",
      'git log -n 5 --format="%H%n%ad%n%B---" --date=short',
      "gh issue list --state open --limit 50 --json number,title,labels",
    ]);
  });

  it.each(["summary", "full", "both"])(
    "does not turn a failed %s query into an empty queue",
    (failed) => {
      const error = new Error("gh authentication failed");
      const result = renderIssues(
        failed === "full" ? "[]" : error,
        failed === "summary" ? "[]" : error
      );
      expect(result.summary).toEqual(
        failed === "full" ? [] : { error: "GitHub issue query failed" }
      );
      expect(result.full).toEqual(
        failed === "summary" ? [] : { error: "GitHub issue query failed" }
      );
    }
  );
});

describe("renderTemplate final-pass substitution", () => {
  it.each(["!", "!?"])("keeps %s shell output literal", (prefix) => {
    const output =
      "!?`echo AGAIN` !`echo AGAIN` @spill:x=`echo AGAIN` {{ INPUTS }} {{ HISTORY }}";
    vi.mocked(execSync).mockReturnValue(output);
    const path = template(`${prefix}\`echo FIRST\` {{ INPUTS }} {{ HISTORY }}`);
    expect(renderTemplate(path, { INPUTS: "plan", HISTORY: "history" })).toBe(
      `${output} plan history`
    );
    expect(execSync).toHaveBeenCalledTimes(1);
  });

  it("keeps try-shell fallback text literal", () => {
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error("command unavailable");
    });
    const path = template("!?`missing|||{{ INPUTS }} {{ HISTORY }}`");
    expect(renderTemplate(path, { INPUTS: "plan", HISTORY: "history" })).toBe(
      "{{ INPUTS }} {{ HISTORY }}"
    );
  });

  it("executes try-shell before plain shell regardless of source order", () => {
    vi.mocked(execSync).mockImplementation((command) => String(command));
    const path = template("!`plain` !?`try`");
    expect(renderTemplate(path, { INPUTS: "", HISTORY: "" })).toBe("plain try");
    expect(vi.mocked(execSync).mock.calls.map(([command]) => command)).toEqual([
      "try",
      "plain",
    ]);
  });

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
