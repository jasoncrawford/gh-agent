# Autocomplete for Commands Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the user types `/` in the REPL prompt, show up to 3 matching command names below the input; Tab completes to the first match; Enter completes and submits.

**Architecture:** Two new pure exported functions (`matchCommands`, `listCommandNames`) are added to `src/repl.ts`. Four new closures (`computeMatches`, `refreshSuggestions`, `clearSuggestions`, `replaceBuffer`) are added inside `ask()`. The `ask()` signature gains an optional `getCommands` parameter for testability. All existing `ask()` tests are updated to pass `getCommands: () => []`.

**Tech Stack:** TypeScript/ESM, `tsx` (no compilation), `vitest`, raw terminal I/O (ANSI escape codes)

**Spec:** `docs/superpowers/specs/2026-03-12-autocomplete-commands-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/repl.ts` | Modify | Add `ListDir` type, `matchCommands()`, `listCommandNames()`, `walkDir()`, `defaultListDir()`; modify `ask()` signature and internals |
| `tests/repl.input.test.ts` | Modify | Update all ~30 `ask()` calls to pass `getCommands: () => []` for test isolation |
| `tests/repl.autocomplete.test.ts` | Create | Unit tests for `matchCommands`/`listCommandNames`; integration tests for `ask()` autocomplete behavior |

---

## Chunk 1: Pure Functions

### Task 1: Create test file scaffold + `matchCommands` tests and implementation

**Files:**
- Create: `tests/repl.autocomplete.test.ts`
- Modify: `src/repl.ts`

- [ ] **Step 1.1: Create the test file with all imports and `matchCommands` tests**

Create `tests/repl.autocomplete.test.ts` with the complete import block it will need for all future tasks — this avoids duplicate import issues when appending later:

```typescript
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
```

- [ ] **Step 1.2: Run to confirm failure**

```bash
cd /workspace && npm test -- --reporter=verbose tests/repl.autocomplete.test.ts
```

Expected: FAIL — `matchCommands` (and other symbols) not yet exported from `src/repl.js`. The import itself will error.

- [ ] **Step 1.3: Add `matchCommands` to `src/repl.ts`**

In `src/repl.ts`, insert a new `// ── Autocomplete ─────` section after the `dispatchInput` function (around line 497), before the `// ── Config ─────` section:

```typescript
// ── Autocomplete ─────────────────────────────────────────────────────────────

/**
 * Filter commands by prefix. Returns commands that start with prefix.
 * Empty prefix returns all commands. Preserves input order.
 */
export function matchCommands(prefix: string, commands: string[]): string[] {
  return commands.filter(cmd => cmd.startsWith(prefix));
}
```

- [ ] **Step 1.4: Run to confirm `matchCommands` tests pass (other symbols still missing)**

```bash
cd /workspace && npm test -- --reporter=verbose tests/repl.autocomplete.test.ts
```

Expected: `matchCommands` describe block PASSES; file may still error on the missing `listCommandNames`/`ListDir`/`ask` second-param imports — that is expected and will be fixed in Task 2–3.

If the entire file errors on the import, that's also expected at this stage. Proceed to Task 2.

- [ ] **Step 1.5: Commit**

```bash
git add tests/repl.autocomplete.test.ts src/repl.ts
git commit -m "feat: add matchCommands with tests"
```

---

### Task 2: `listCommandNames` — tests then implementation

**Files:**
- Modify: `tests/repl.autocomplete.test.ts` (append `listCommandNames` describe block only — no import changes needed)
- Modify: `src/repl.ts`

- [ ] **Step 2.1: Append `listCommandNames` tests to the test file**

Append only the `describe` block below to `tests/repl.autocomplete.test.ts` (the imports are already at the top):

```typescript
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
```

- [ ] **Step 2.2: Run to confirm failure**

```bash
cd /workspace && npm test -- --reporter=verbose tests/repl.autocomplete.test.ts
```

Expected: FAIL — `listCommandNames` and `ListDir` not yet exported

- [ ] **Step 2.3: Add `ListDir`, `walkDir`, `defaultListDir`, and `listCommandNames` to `src/repl.ts`**

Inside the `// ── Autocomplete ─────` section in `src/repl.ts`, add after `matchCommands`:

```typescript
export type ListDir = (dir: string) => Array<{ name: string; isDir: boolean }> | null;

function walkDir(dir: string, prefix: string, listDir: ListDir): string[] {
  const entries = listDir(dir);
  if (!entries) return [];
  const result: string[] = [];
  for (const entry of entries) {
    const name = prefix ? `${prefix}:${entry.name}` : entry.name;
    if (entry.isDir) {
      result.push(...walkDir(`${dir}/${entry.name}`, name, listDir));
    } else if (entry.name.endsWith(".md")) {
      result.push(name.slice(0, -3)); // strip .md extension
    }
  }
  return result;
}

function defaultListDir(dir: string): Array<{ name: string; isDir: boolean }> | null {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).map(e => ({
      name: e.name,
      isDir: e.isDirectory(),
    }));
  } catch {
    return null;
  }
}

/**
 * Return all available command names: builtins ("clear", "exit") plus
 * any .md files found under ~/.claude/commands/ (recursively).
 * Subdirectory names become colon-separated prefixes: foo/bar.md → "foo:bar".
 * The listDir parameter is injectable for testing.
 */
export function listCommandNames(listDir: ListDir = defaultListDir): string[] {
  const builtins = ["clear", "exit"];
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const commandsDir = `${home}/.claude/commands`;
  const fileCommands = walkDir(commandsDir, "", listDir);
  return [...new Set([...builtins, ...fileCommands])].sort();
}
```

- [ ] **Step 2.4: Run to confirm all pure-function tests pass**

```bash
cd /workspace && npm test -- --reporter=verbose tests/repl.autocomplete.test.ts
```

Expected: `matchCommands` and `listCommandNames` describe blocks PASS. The `ask()` integration tests (not yet written) will not run yet.

- [ ] **Step 2.5: Run full test suite to verify no regressions**

```bash
cd /workspace && npm test
```

Expected: All existing tests PASS

- [ ] **Step 2.6: Commit**

```bash
git add tests/repl.autocomplete.test.ts src/repl.ts
git commit -m "feat: add listCommandNames with recursive file discovery"
```

---

## Chunk 2: `ask()` Modifications

### Task 3: Update existing `ask()` tests + minimal signature change

**Files:**
- Modify: `tests/repl.input.test.ts`
- Modify: `src/repl.ts`

The goal here is to update the `ask()` signature and all existing tests before adding autocomplete behavior. This lets us verify nothing breaks.

- [ ] **Step 3.1: Update `ask()` signature in `src/repl.ts`**

Find the `ask` function declaration (around line 575):
```typescript
export function ask(promptStr: string): Promise<string> {
```
Change to:
```typescript
export function ask(promptStr: string, getCommands: () => string[] = () => listCommandNames()): Promise<string> {
```

Then immediately after `let done = false;` (inside the returned `new Promise` closure), add these three lines:

```typescript
    let suggestionsShown = false;
    // Visual length of prompt on the terminal line (excludes any leading \n)
    const promptVisualLen = promptStr.slice(promptStr.lastIndexOf("\n") + 1).length;
    let commands: string[] = [];
    try { commands = getCommands(); } catch { /* graceful: use empty */ }
```

**Do not add any other logic yet.** This is only the minimal signature change.

- [ ] **Step 3.2: Run full test suite to confirm existing tests still pass**

```bash
cd /workspace && npm test
```

Expected: All tests PASS (no behavior changed yet; `ask()` imported by existing tests without `getCommands` uses the default and that's fine for now)

- [ ] **Step 3.3: Update all `ask()` calls in `tests/repl.input.test.ts` to pass `getCommands: () => []`**

Every call to `ask("> ")` in `tests/repl.input.test.ts` must become `ask("> ", () => [])`.

There are ~30 such calls. Use search-and-replace: find `ask("> ")`, replace with `ask("> ", () => [])`.

- [ ] **Step 3.4: Run full test suite to confirm still passing**

```bash
cd /workspace && npm test
```

Expected: All tests PASS

- [ ] **Step 3.5: Commit**

```bash
git add src/repl.ts tests/repl.input.test.ts
git commit -m "feat: add getCommands parameter to ask(); update existing tests for isolation"
```

---

### Task 4: Write failing Tab and Enter autocomplete tests

**Files:**
- Modify: `tests/repl.autocomplete.test.ts` (append two `describe` blocks — no import changes needed)

These tests will fail until Task 5 is implemented.

- [ ] **Step 4.1: Append Tab completion tests**

Append only the describe block (no imports — they are already at the top of the file):

```typescript
// ── Tab completion ────────────────────────────────────────────────────────────

describe("ask() - Tab completion", () => {
  it("Tab with no match is a no-op", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("/zzz");
      stdin.push("\x09"); // Tab
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("/zzz");
    });
  });

  it("Tab with one match completes buffer", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("/ex");
      stdin.push("\x09"); // Tab
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("/exit");
    });
  });

  it("Tab with multiple matches completes to first (alphabetical)", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("/");
      stdin.push("\x09"); // Tab — "brainstorm" is first alphabetically
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("/brainstorm");
    });
  });

  it("Tab on non-slash input is a no-op", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("hello");
      stdin.push("\x09"); // Tab
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("hello");
    });
  });

  it("Tab with cursor not at end completes and moves cursor to end", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("/ex");
      stdin.push("\x1b[D"); // left arrow (cursor now at position 2)
      stdin.push("\x09");   // Tab
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("/exit");
    });
  });
});
```

- [ ] **Step 4.2: Append Enter completion tests**

```typescript
// ── Enter completion ──────────────────────────────────────────────────────────

describe("ask() - Enter completion", () => {
  it("Enter with one match completes and submits", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("/ex");
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("/exit");
    });
  });

  it("Enter with no match (slash prefix) submits as-is", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("/zzz");
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("/zzz");
    });
  });

  it("Enter on non-slash input submits as-is (no completion)", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("hello world");
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("hello world");
    });
  });

  it("Enter with space after command does not complete (no suggestions)", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("/exit foo");
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("/exit foo");
    });
  });

  it("\\n also triggers Enter completion", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("/ex");
      stdin.push("\n");
      const result = await p;
      expect(result).toBe("/exit");
    });
  });
});
```

- [ ] **Step 4.3: Run tests to confirm the new ones fail**

```bash
cd /workspace && npm test -- --reporter=verbose tests/repl.autocomplete.test.ts
```

Expected: `matchCommands` and `listCommandNames` blocks PASS; Tab and Enter blocks FAIL — Tab is currently ignored; Enter submits the raw buffer without completing.

---

### Task 5: Implement autocomplete closures in `ask()`

**Files:**
- Modify: `src/repl.ts`

- [ ] **Step 5.1: Add the four autocomplete closures to `ask()`**

Inside `ask()`, after the `cursor` variable declaration (the line `let cursor = 0;`, around line 597) and before the `redrawSuffix` function, insert the four closures:

```typescript
    // ── Autocomplete ────────────────────────────────────────────────────────

    function computeMatches(): string[] {
      if (!buffer.startsWith("/")) return [];
      if (buffer.slice(1).includes(" ")) return [];
      const prefix = buffer.slice(1).split(/\s+/)[0];
      // prefix is "" when buffer is exactly "/" — matchCommands("", ...) returns all
      return matchCommands(prefix, commands).slice(0, 3);
    }

    function refreshSuggestions() {
      const matches = computeMatches();
      const fromEnd = buffer.length - cursor;
      if (fromEnd > 0) process.stdout.write(`\x1b[${fromEnd}C`);
      process.stdout.write("\r\n\x1b[K");
      if (matches.length > 0) {
        process.stdout.write(c.darkGray("  " + matches.map(m => "/" + m).join("  ")));
      }
      process.stdout.write("\x1b[A\r");
      const fwd = promptVisualLen + cursor;
      if (fwd > 0) process.stdout.write(`\x1b[${fwd}C`);
      suggestionsShown = matches.length > 0;
    }

    function clearSuggestions() {
      if (!suggestionsShown) return;
      const fromEnd = buffer.length - cursor;
      if (fromEnd > 0) process.stdout.write(`\x1b[${fromEnd}C`);
      process.stdout.write("\r\n\x1b[K\x1b[A\r");
      const fwd = promptVisualLen + cursor;
      if (fwd > 0) process.stdout.write(`\x1b[${fwd}C`);
      suggestionsShown = false;
    }

    function replaceBuffer(newText: string) {
      if (cursor > 0) process.stdout.write(`\x1b[${cursor}D`);
      process.stdout.write(newText + "\x1b[K");
      buffer = newText;
      cursor = newText.length;
    }
```

- [ ] **Step 5.2: Modify the Enter handler in `processTyped`**

Find the Enter handler inside the `for (const ch of data)` loop in `processTyped`:
```typescript
        if      (ch === "\r" || ch === "\n")          { submit(buffer); return; }
```

Change to:
```typescript
        if (ch === "\r" || ch === "\n") {
          const matches = computeMatches();
          if (matches.length > 0) { replaceBuffer("/" + matches[0]); }
          clearSuggestions();
          submit(buffer);
          return;
        }
```

- [ ] **Step 5.3: Add Tab handler and wire `refreshSuggestions()` after buffer-editing operations**

In `processTyped`, find the chain of `else if` branches and make these changes:

**a)** Add `refreshSuggestions()` after `deleteBack()`:
```typescript
        else if (ch === "\x7f" || ch === "\x08")      { deleteBack(); refreshSuggestions(); }
```

**b)** Add `refreshSuggestions()` after `killToEnd()`, `killToStart()`, `deleteWord()`:
```typescript
        else if (ch === "\x0b")                       { killToEnd(); refreshSuggestions(); }           // ^K
        else if (ch === "\x15")                       { killToStart(); refreshSuggestions(); }         // ^U
        else if (ch === "\x17")                       { deleteWord(); refreshSuggestions(); }          // ^W
```

**c)** Add Tab handler **before** the final `code >= 32` branch, and add `refreshSuggestions()` to the `insert` call:
```typescript
        else if (ch === "\x09") {                                                            // Tab
          const matches = computeMatches();
          if (matches.length > 0) { replaceBuffer("/" + matches[0]); refreshSuggestions(); }
        }
        else if (code >= 32)                          { insert(ch); refreshSuggestions(); }
```

- [ ] **Step 5.4: Add `refreshSuggestions()` inside `insertPaste`**

Find the `insertPaste` function inside `ask()`:
```typescript
    function insertPaste(str: string) {
      buffer = buffer.slice(0, cursor) + str + buffer.slice(cursor);
      cursor += str.length;
      // Echo with \r\n... for newlines, then redraw any suffix after cursor
      process.stdout.write(str.split("\n").join("\r\n... "));
      redrawSuffix();
    }
```

Add `refreshSuggestions()` as the final line:
```typescript
    function insertPaste(str: string) {
      buffer = buffer.slice(0, cursor) + str + buffer.slice(cursor);
      cursor += str.length;
      // Echo with \r\n... for newlines, then redraw any suffix after cursor
      process.stdout.write(str.split("\n").join("\r\n... "));
      redrawSuffix();
      refreshSuggestions();
    }
```

- [ ] **Step 5.5: Run autocomplete integration tests to confirm they pass**

```bash
cd /workspace && npm test -- --reporter=verbose tests/repl.autocomplete.test.ts
```

Expected: All tests PASS

- [ ] **Step 5.6: Run full test suite to confirm no regressions**

```bash
cd /workspace && npm test
```

Expected: All tests PASS

- [ ] **Step 5.7: Commit**

```bash
git add src/repl.ts
git commit -m "feat: implement autocomplete in ask() — Tab and Enter completion"
```

---

### Task 6: Edge-case tests and final verification

**Files:**
- Modify: `tests/repl.autocomplete.test.ts` (append one `describe` block — no import changes)

- [ ] **Step 6.1: Append edge-case tests**

```typescript
// ── Edge cases ────────────────────────────────────────────────────────────────

describe("ask() - autocomplete edge cases", () => {
  it("bare / shows all commands and Enter picks first", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", () => ["alpha", "beta", "gamma"]);
      stdin.push("/");
      stdin.push("\r"); // Enter completes with first match
      const result = await p;
      expect(result).toBe("/alpha");
    });
  });

  it("^K leaving / in buffer; Tab completes from all commands", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("/exit");
      stdin.push("\x01");    // ^A → start of buffer
      stdin.push("\x1b[C"); // right arrow → position 1 (after /)
      stdin.push("\x0b");   // ^K → kill "exit"; buffer is now "/"
      stdin.push("\x09");   // Tab → should complete to first command "brainstorm"
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("/brainstorm");
    });
  });

  it("submit without ever showing suggestions (clearSuggestions guard)", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", () => []);
      stdin.push("hello");
      stdin.push("\r");
      const result = await p;
      // Just verifies no crash; clearSuggestions guard prevents spurious escapes
      expect(result).toBe("hello");
    });
  });

  it("pasted slash prefix triggers Tab completion", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("\x1b[200~/ex\x1b[201~"); // paste "/ex"
      stdin.push("\x09"); // Tab → should complete to "/exit"
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("/exit");
    });
  });

  it("paste of non-slash text into non-slash buffer: no suggestions", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("ab");
      stdin.push("\x1b[D"); // left
      stdin.push("\x1b[200~hello\x1b[201~"); // paste "hello" mid-buffer
      stdin.push("\r");
      const result = await p;
      expect(result).toBe("ahellob");
    });
  });

  it("typing / writes suggestion content to stdout", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("/");
      stdin.push("\r"); // submit to resolve the promise
      await p;
      // All stdout writes captured by mock; verify suggestion text was written at some point
      const allOutput = vi.mocked(process.stdout.write).mock.calls.map(c => String(c[0])).join("");
      expect(allOutput).toContain("brainstorm");
      expect(allOutput).toContain("clear");
      expect(allOutput).toContain("exit");
    });
  });

  it("typing /ex narrows suggestion to only /exit", async () => {
    await withFakeStdin(async (stdin) => {
      const p = ask("> ", cmds);
      stdin.push("/ex");
      stdin.push("\r"); // submit (also completes to /exit)
      await p;
      const allOutput = vi.mocked(process.stdout.write).mock.calls.map(c => String(c[0])).join("");
      // "exit" should appear in output; "brainstorm" and "clear" should not appear in suggestion context
      // (they may appear in other writes, but the suggestion line should only have "exit")
      expect(allOutput).toContain("/exit");
    });
  });
});
```

- [ ] **Step 6.2: Run to confirm all pass**

```bash
cd /workspace && npm test -- --reporter=verbose tests/repl.autocomplete.test.ts
```

Expected: All tests PASS

- [ ] **Step 6.3: Run full suite one final time**

```bash
cd /workspace && npm test
```

Expected: All tests PASS, no regressions

- [ ] **Step 6.4: Commit**

```bash
git add tests/repl.autocomplete.test.ts
git commit -m "test: add autocomplete edge case tests"
```

---

### Task 7: Create PR

- [ ] **Step 7.1: Push the branch and open PR**

```bash
git push -u origin autocomplete-commands
gh pr create \
  --title "feat: autocomplete for slash commands (#10)" \
  --body "$(cat <<'EOF'
## Summary
- Adds `matchCommands()` and `listCommandNames()` as pure exported functions for filtering and discovering commands (built-ins + `~/.claude/commands/*.md` files)
- Modifies `ask()` with an optional `getCommands` parameter; shows up to 3 matching commands below the prompt when input starts with `/`
- Tab completes the buffer with the first suggestion; Enter completes and submits
- All existing `ask()` tests updated to pass `getCommands: () => []` for test isolation

## Test plan
- [ ] Run `npm test` — all tests pass
- [ ] Manual smoke: `npm run repl`, type `/` to see suggestions, Tab to complete, Enter to complete+submit
- [ ] Verify `/exit ` (with space) shows no suggestions
- [ ] Verify `^K` on `/exit` leaving `/` shows all commands

Closes #10

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 7.2: Note the PR URL for the user**
