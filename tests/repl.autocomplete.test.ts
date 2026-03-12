import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PassThrough } from "stream";
import { ask, matchCommands, listCommandNames, type ListDir } from "../src/repl.js";

// ── Test harness for ask() integration tests ──────────────────────────────────

function makeStdin() {
  const stream = new PassThrough();
  stream.setEncoding("utf8");
  (stream as any).setRawMode = vi.fn();
  return stream;
}

let origStdin: NodeJS.ReadStream;

function withFakeStdin(fn: (stdin: PassThrough) => Promise<void>): Promise<void> {
  const stdin = makeStdin();
  Object.defineProperty(process, "stdin", { value: stdin, configurable: true });
  return fn(stdin).finally(() => {
    Object.defineProperty(process, "stdin", { value: origStdin, configurable: true });
  });
}

beforeEach(() => {
  origStdin = process.stdin;
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  Object.defineProperty(process, "stdin", { value: origStdin, configurable: true });
  vi.restoreAllMocks();
});

const cmds = () => ["brainstorm", "clear", "exit"];

// ── matchCommands ─────────────────────────────────────────────────────────────

describe("matchCommands", () => {
  it("filters commands by prefix", () => {
    expect(matchCommands("ex", ["brainstorm", "clear", "exit"])).toEqual(["exit"]);
  });

  it("empty prefix returns all commands", () => {
    expect(matchCommands("", ["brainstorm", "clear", "exit"])).toEqual(["brainstorm", "clear", "exit"]);
  });

  it("no matches returns empty array", () => {
    expect(matchCommands("zzz", ["brainstorm", "clear", "exit"])).toEqual([]);
  });

  it("is case-sensitive", () => {
    expect(matchCommands("Ex", ["brainstorm", "clear", "exit"])).toEqual([]);
  });

  it("prefix matching includes exact matches", () => {
    expect(matchCommands("exit", ["brainstorm", "clear", "exit"])).toEqual(["exit"]);
  });

  it("handles empty command list", () => {
    expect(matchCommands("ex", [])).toEqual([]);
  });
});

// ── listCommandNames ──────────────────────────────────────────────────────────

describe("listCommandNames", () => {
  it("always includes builtins clear and exit", () => {
    const result = listCommandNames(() => null);
    expect(result).toContain("clear");
    expect(result).toContain("exit");
  });

  it("returns only builtins when directory is missing", () => {
    const result = listCommandNames(() => null);
    expect(result).toEqual(["clear", "exit"]);
  });

  it("includes a file at root level", () => {
    const listDir: ListDir = (dir) => {
      if (dir.endsWith("commands")) return [{ name: "brainstorm.md", isDir: false }];
      return null;
    };
    const result = listCommandNames(listDir);
    expect(result).toContain("brainstorm");
  });

  it("converts subdirectory file to colon-separated name", () => {
    const listDir: ListDir = (dir) => {
      if (dir.endsWith("commands")) return [{ name: "foo", isDir: true }];
      if (dir.endsWith("/foo")) return [{ name: "bar.md", isDir: false }];
      return null;
    };
    const result = listCommandNames(listDir);
    expect(result).toContain("foo:bar");
  });

  it("handles three levels of nesting", () => {
    const listDir: ListDir = (dir) => {
      if (dir.endsWith("commands")) return [{ name: "a", isDir: true }];
      if (dir.endsWith("/a")) return [{ name: "b", isDir: true }];
      if (dir.endsWith("/b")) return [{ name: "c.md", isDir: false }];
      return null;
    };
    const result = listCommandNames(listDir);
    expect(result).toContain("a:b:c");
  });

  it("deduplicates when a file name matches a builtin", () => {
    const listDir: ListDir = (dir) => {
      if (dir.endsWith("commands")) return [{ name: "clear.md", isDir: false }];
      return null;
    };
    const result = listCommandNames(listDir);
    const clears = result.filter(c => c === "clear");
    expect(clears).toHaveLength(1);
  });

  it("ignores non-.md files", () => {
    const listDir: ListDir = (dir) => {
      if (dir.endsWith("commands")) return [
        { name: "notes.txt", isDir: false },
        { name: "script.sh", isDir: false },
        { name: "valid.md", isDir: false },
      ];
      return null;
    };
    const result = listCommandNames(listDir);
    expect(result).not.toContain("notes");
    expect(result).not.toContain("script");
    expect(result).toContain("valid");
  });

  it("result is sorted alphabetically", () => {
    const listDir: ListDir = (dir) => {
      if (dir.endsWith("commands")) return [
        { name: "zebra.md", isDir: false },
        { name: "alpha.md", isDir: false },
      ];
      return null;
    };
    const result = listCommandNames(listDir);
    expect(result).toEqual([...result].sort());
  });
});
