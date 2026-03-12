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
