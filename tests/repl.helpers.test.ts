import { describe, it, expect } from "vitest";
import { stripAnsi } from "./helpers.js";
import {
  trunc,
  fmtCount,
  fmtStats,
  fmtArgs,
  toolResultText,
  fmtEditResult,
  fmtHunk,
  c,
} from "../src/repl.js";

describe("trunc", () => {
  it("returns short string unchanged", () => {
    expect(trunc("hello", 10)).toBe("hello");
  });

  it("returns string of exactly n chars unchanged", () => {
    expect(trunc("hello", 5)).toBe("hello");
  });

  it("truncates string of n+1 chars", () => {
    expect(trunc("hello!", 5)).toBe("hell…");
  });

  it("normalizes whitespace before truncating", () => {
    const result = trunc("hello\n  world", 20);
    expect(result).toBe("hello world");
  });

  it("default n=80: string of 81 chars truncated", () => {
    const s = "a".repeat(81);
    const result = trunc(s);
    expect(result.length).toBe(80);
    expect(result.endsWith("…")).toBe(true);
  });

  it("string of exactly 80 chars unchanged", () => {
    const s = "a".repeat(80);
    expect(trunc(s)).toBe(s);
  });
});

describe("fmtCount", () => {
  it("singular: 1 turn", () => {
    expect(fmtCount(1, "turn")).toBe("1 turn");
  });

  it("plural default: 0 turns", () => {
    expect(fmtCount(0, "turn")).toBe("0 turns");
  });

  it("plural default: 2 turns", () => {
    expect(fmtCount(2, "turn")).toBe("2 turns");
  });

  it("custom plural", () => {
    expect(fmtCount(2, "turn", "turnovers")).toBe("2 turnovers");
  });

  it("singular with custom plural: 1 ox", () => {
    expect(fmtCount(1, "ox", "oxen")).toBe("1 ox");
  });

  it("plural with custom plural: 2 oxen", () => {
    expect(fmtCount(2, "ox", "oxen")).toBe("2 oxen");
  });
});

describe("fmtStats", () => {
  it("just seconds", () => {
    expect(fmtStats(5)).toBe("5s");
  });

  it("seconds and 1 turn", () => {
    expect(fmtStats(5, 1)).toBe("5s, 1 turn");
  });

  it("seconds and 3 turns", () => {
    expect(fmtStats(5, 3)).toBe("5s, 3 turns");
  });

  it("seconds, turns, and output tokens", () => {
    expect(fmtStats(5, 2, 100)).toBe("5s, 2 turns, tokens: 100 out");
  });

  it("seconds, turns, and both token types", () => {
    expect(fmtStats(5, 2, 100, 500)).toBe("5s, 2 turns, tokens: 500 in / 100 out");
  });

  it("zero turns and zero tokens omitted", () => {
    expect(fmtStats(5, 0, 0)).toBe("5s");
  });

  it("undefined turns, output tokens shown", () => {
    expect(fmtStats(5, undefined, 100, 0)).toBe("5s, tokens: 0 in / 100 out");
  });
});

describe("fmtArgs", () => {
  it("empty object returns empty string", () => {
    expect(fmtArgs({})).toBe("");
  });

  it("single entry", () => {
    expect(fmtArgs({ command: "ls" })).toBe("command=ls");
  });

  it("long value truncated to maxVal (default 50)", () => {
    const longVal = "x".repeat(60);
    const result = fmtArgs({ key: longVal });
    expect(result).toBe(`key=${"x".repeat(49)}…`);
  });

  it("multiple entries joined with comma", () => {
    const result = fmtArgs({ a: "1", b: "2" });
    expect(result).toBe("a=1, b=2");
  });

  it("numeric values converted to string", () => {
    expect(fmtArgs({ count: 42 } as any)).toBe("count=42");
  });

  it("boolean values converted to string", () => {
    expect(fmtArgs({ flag: true } as any)).toBe("flag=true");
  });
});

describe("toolResultText", () => {
  it("string content returned directly", () => {
    expect(toolResultText({ content: "hello" })).toBe("hello");
  });

  it("array with text block", () => {
    expect(toolResultText({ content: [{ type: "text", text: "hi" }] })).toBe("hi");
  });

  it("array with tool_reference", () => {
    expect(toolResultText({ content: [{ type: "tool_reference", tool_name: "Write" }] })).toBe("[tool:Write]");
  });

  it("mixed array: text + tool_reference joined with space", () => {
    const result = toolResultText({
      content: [
        { type: "text", text: "done" },
        { type: "tool_reference", tool_name: "Read" },
      ],
    });
    expect(result).toBe("done [tool:Read]");
  });

  it("unknown type in array returns [type]", () => {
    expect(toolResultText({ content: [{ type: "image" }] })).toBe("[image]");
  });

  it("null content returns empty string", () => {
    expect(toolResultText({ content: null })).toBe("[?]");
  });

  it("single non-array object treated as array of one", () => {
    expect(toolResultText({ content: { type: "text", text: "single" } })).toBe("single");
  });
});

describe("fmtEditResult", () => {
  it("structuredPatch with hunks renders hunks", () => {
    const hunk = {
      oldStart: 1, oldLines: 2, newStart: 1, newLines: 3,
      lines: ["-old", "+new", " ctx"],
    };
    const b = { _msg: { tool_use_result: { structuredPatch: [hunk] } }, content: "" };
    const result = stripAnsi(fmtEditResult(b));
    expect(result).toContain("@@ -1,2 +1,3 @@");
    expect(result).toContain("-old");
    expect(result).toContain("+new");
  });

  it("empty patch array falls back to toolResultText", () => {
    const b = { _msg: { tool_use_result: { structuredPatch: [] } }, content: "fallback text" };
    const result = stripAnsi(fmtEditResult(b));
    expect(result).toContain("fallback text");
  });

  it("no _msg falls back to toolResultText", () => {
    const b = { content: "no msg" };
    const result = stripAnsi(fmtEditResult(b));
    expect(result).toContain("no msg");
  });

  it("structuredPatch = null falls back", () => {
    const b = { _msg: { tool_use_result: { structuredPatch: null } }, content: "null patch" };
    const result = stripAnsi(fmtEditResult(b));
    expect(result).toContain("null patch");
  });
});

describe("fmtHunk", () => {
  const hunk = {
    oldStart: 1, oldLines: 3, newStart: 1, newLines: 4,
    lines: ["+added line", "-removed line", " context line"],
  };

  it("header line has @@ format", () => {
    const result = stripAnsi(fmtHunk(hunk));
    expect(result).toContain("@@ -1,3 +1,4 @@");
  });

  it("lines starting with + are in result (bgGreen applied)", () => {
    const result = fmtHunk(hunk);
    // bgGreen ANSI: \x1b[48;5;22m
    expect(result).toContain("\x1b[48;5;22m");
  });

  it("lines starting with - are in result (bgRed applied)", () => {
    const result = fmtHunk(hunk);
    // bgRed ANSI: \x1b[48;5;52m
    expect(result).toContain("\x1b[48;5;52m");
  });

  it("context lines are darkGray", () => {
    const result = fmtHunk(hunk);
    // darkGray ANSI: \x1b[90m
    expect(result).toContain("\x1b[90m context line");
  });

  it("all three types in correct order", () => {
    const result = stripAnsi(fmtHunk(hunk));
    const lines = result.split("\n");
    expect(lines[0]).toContain("@@");
    // The padEnd ensures + line is long but starts with "+added line"
    expect(lines[1].trimEnd()).toContain("+added line");
    expect(lines[2].trimEnd()).toContain("-removed line");
    expect(lines[3]).toContain(" context line");
  });
});
