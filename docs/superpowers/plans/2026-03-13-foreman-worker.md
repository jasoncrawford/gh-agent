# Foreman/Worker Architecture Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a foreman process that manages a queue of GitHub issues and a worker mode that claims tasks and works them to completion using the Claude Agent SDK.

**Architecture:** The existing webhook listener (`src/index.ts`) evolves into a foreman (`src/foreman.ts`) that tracks tasks and coordinates workers over WebSocket. Workers are a new mode of the existing REPL (`src/repl.ts --worker-mode`), each maintaining a local event queue populated while the agent runs. Three PRs: reorg first, then foreman, then worker.

**Tech Stack:** TypeScript/ESM, tsx, `ws` (WebSocket), Claude Agent SDK, GitHub REST API (via `fetch`), Vitest

**Spec:** `docs/superpowers/specs/2026-03-13-foreman-worker-design.md`

---

## Chunk 1: Reorg — Extract display.ts (PR 1)

Pure behavior-preserving refactor. No functional changes. All existing tests must pass before and after.

**File map:**
- Create: `src/display.ts` — display engine (colors, formatting, markdown, printing, status line, VERBOSE flag)
- Modify: `src/repl.ts` — remove display code, import+re-export from display.ts (no test file changes needed)

> **ESM live-binding note:** `VERBOSE` and `_statusActive` are declared `export let` in `display.ts`. ESM live bindings propagate mutations across module boundaries, so `setVerbose(true)` in one module is visible to all importers of `VERBOSE` from `display.ts`. Re-exports from `repl.ts` preserve these live bindings. This is the standard ESM behavior — no special handling needed.

### Task 1: Verify baseline tests pass

- [ ] **Step 1: Run the full test suite**

  ```bash
  npm test
  ```

  Expected: all tests pass. Note the count. If any are failing, stop and fix before continuing.

### Task 2: Create src/display.ts and wire up repl.ts

Move everything display-related out of `src/repl.ts` into `src/display.ts`. Key changes vs. the original:
- `VERBOSE`/`setVerbose` move here (they control display verbosity). `VERBOSE` is initialized from `process.argv` at module load in `display.ts` — same behavior as before, just different file.
- All moved symbols get explicit `export`.
- `W` and `hr` stay as `const` (not `let`).
- `repl.ts` removes the moved code and replaces it with import+re-export, so all existing test imports from `src/repl.ts` continue to work with no test changes.

- [ ] **Step 1: Create `src/display.ts`** with the following content:

  ```typescript
  // ── Display width ─────────────────────────────────────────────────────────────

  export const W = 70;
  export const hr = (ch = "─") => ch.repeat(W);

  // ── Verbose flag ──────────────────────────────────────────────────────────────

  export let VERBOSE = process.argv.includes("--verbose");
  export function setVerbose(v: boolean) { VERBOSE = v; }

  // ── Colors ────────────────────────────────────────────────────────────────────

  export const c = {
    skyBlue:   (s: string) => `\x1b[38;5;117m${s}\x1b[0m`,
    gray:      (s: string) => `\x1b[38;5;246m${s}\x1b[0m`,
    amber:     (s: string) => `\x1b[38;5;214m${s}\x1b[0m`,
    sageGreen: (s: string) => `\x1b[38;5;150m${s}\x1b[0m`,
    salmon:    (s: string) => `\x1b[38;5;203m${s}\x1b[0m`,
    boldRed:   (s: string) => `\x1b[1;31m${s}\x1b[0m`,
    darkGray:  (s: string) => `\x1b[90m${s}\x1b[0m`,
    yellow:    (s: string) => `\x1b[38;5;221m${s}\x1b[0m`,
    lavender:  (s: string) => `\x1b[38;5;183m${s}\x1b[0m`,
    bgGreen:   (s: string) => `\x1b[48;5;22m${s}\x1b[49m`,
    bgRed:     (s: string) => `\x1b[48;5;52m${s}\x1b[49m`,
  };

  export const s = {
    bold:          (s: string) => `\x1b[1m${s}\x1b[22m`,
    dim:           (s: string) => `\x1b[2m${s}\x1b[22m`,
    italic:        (s: string) => `\x1b[3m${s}\x1b[23m`,
    underline:     (s: string) => `\x1b[4m${s}\x1b[24m`,
    strikethrough: (s: string) => `\x1b[9m${s}\x1b[29m`,
  };

  // ── Formatting helpers ────────────────────────────────────────────────────────

  export function trunc(str: string, n = 80) {
    str = str.replace(/\s+/g, " ").trim();
    return str.length > n ? str.slice(0, n - 1) + "…" : str;
  }

  export function fmtCount(count: number, singular_noun: string, plural_noun?: string) {
    const noun = (count === 1) ? singular_noun : (plural_noun ?? `${singular_noun}s`);
    return `${count} ${noun}`;
  }

  export function fmtStats(secs: number, turns?: number, outputTokens?: number, inputTokens?: number): string {
    const parts: string[] = [`${secs}s`];
    if (turns) parts.push(fmtCount(turns, "turn"));
    if (outputTokens) {
      const tok = inputTokens != null ? `tokens: ${inputTokens} in / ${outputTokens} out` : `tokens: ${outputTokens} out`;
      parts.push(tok);
    }
    return parts.join(", ");
  }

  export function fmtArgs(input: Record<string, unknown>, maxVal = 50): string {
    return Object.entries(input ?? {})
      .map(([k, v]) => `${k}=${trunc(String(v), maxVal)}`)
      .join(", ");
  }

  export function fmtToolCall(b: any, fmt: string) {
    fmt = c.skyBlue(`\n${fmt}`);
    if (b.input?.description) fmt += c.gray(` # ${b.input.description}`);
    return fmt;
  }

  export function fmtHunk(hunk: any): string {
    const header = c.darkGray(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    const width = process.stdout.columns ?? 80;
    const lines = (hunk.lines as string[]).map(line => {
      if (line.startsWith("+")) return c.bgGreen(line.padEnd(width));
      if (line.startsWith("-")) return c.bgRed(line.padEnd(width));
      return c.darkGray(line);
    });
    return [header, ...lines].join("\n");
  }

  export function fmtEditResult(b: any) {
    const patch = b._msg?.tool_use_result?.structuredPatch;
    if (patch && patch.length > 0) return patch.map(fmtHunk).join("\n");
    return c.darkGray(`→ ${trunc(toolResultText(b), 100)}`);
  }

  export function toolResultText(b: any): string {
    const raw = b.content;
    if (typeof raw === "string") return raw;
    return (Array.isArray(raw) ? raw : [raw])
      .map((x: any) => {
        if (x?.type === "text") return x.text;
        if (x?.type === "tool_reference") return `[tool:${x.tool_name}]`;
        return `[${x?.type ?? "?"}]`;
      })
      .join(" ");
  }

  // ── Markdown renderer ─────────────────────────────────────────────────────────

  export function mdInline(text: string): string {
    text = text.replace(/\*\*(.+?)\*\*/gs,  (_, t) => s.bold(t));
    text = text.replace(/__(.+?)__/gs,      (_, t) => s.bold(t));
    text = text.replace(/`([^`]+)`/g,       (_, t) => s.bold(s.underline(t)));
    return text;
  }

  export function renderTable(tableLines: string[]): string {
    const rows = tableLines.map(line =>
      line.split("|").slice(1, -1).map(cell => cell.trim())
    );
    const isSep = (row: string[]) => row.every(cell => /^[-: ]+$/.test(cell));
    const dataRows = rows.filter(r => !isSep(r));
    const colCount = Math.max(...dataRows.map(r => r.length));
    const widths = Array.from({ length: colCount }, (_, i) =>
      Math.max(...dataRows.map(r => (r[i] ?? "").length))
    );
    const renderRow = (row: string[]) =>
      "│ " + widths.map((w, i) => mdInline((row[i] ?? "").padEnd(w))).join(" │ ") + " │";
    const divider = "├─" + widths.map(w => "─".repeat(w)).join("─┼─") + "─┤";
    const out: string[] = [];
    for (const row of rows) {
      if (isSep(row)) { out.push(divider); continue; }
      out.push(renderRow(row));
    }
    return out.join("\n");
  }

  export function renderMarkdown(text: string): string {
    const lines = text.split("\n");
    const out: string[] = [];
    let inCode = false;
    const codeLines: string[] = [];
    let tableLines: string[] = [];

    function flushTable() {
      if (tableLines.length) { out.push(renderTable(tableLines)); tableLines = []; }
    }

    for (const line of lines) {
      if (line.startsWith("```")) {
        flushTable();
        if (!inCode) { inCode = true; codeLines.length = 0; }
        else         { inCode = false; out.push(codeLines.map(l => "  " + l).join("\n")); }
        continue;
      }
      if (inCode) { codeLines.push(line); continue; }

      if (line.trimStart().startsWith("|")) { tableLines.push(line); continue; }
      flushTable();

      if (/^[-*_]{3,}\s*$/.test(line)) { out.push("─".repeat(W)); continue; }

      const heading = line.match(/^(#{1,6})\s+(.*)/);
      if (heading) {
        const text = mdInline(heading[2]);
        out.push(s.bold(heading[1] === "#" ? text.toUpperCase() : text));
        continue;
      }

      if (line.startsWith("> ")) { out.push("▏ " + mdInline(line.slice(2))); continue; }

      const li = line.match(/^(\s*)[-*+]\s+(.*)/);
      if (li) { out.push(li[1] + "• " + mdInline(li[2])); continue; }

      const oli = line.match(/^(\s*)(\d+)\.\s+(.*)/);
      if (oli) { out.push(oli[1] + oli[2] + ". " + mdInline(oli[3])); continue; }

      out.push(mdInline(line));
    }

    if (inCode && codeLines.length) out.push(codeLines.map(l => "  " + l).join("\n"));
    flushTable();
    return out.join("\n");
  }

  // ── FORMATS ───────────────────────────────────────────────────────────────────

  export type Fmt = (data: any) => string | null;
  export type FmtEntry = Fmt | { quiet?: Fmt; verbose?: Fmt };
  export type FmtTable = Record<string, FmtEntry>;

  export const ASSISTANT_BLOCK_FMT: FmtTable = {
    thinking: (b) => c.gray(`\n${renderMarkdown(b.thinking ?? "")}`),
    text:     (b) => c.yellow(`\n${renderMarkdown(b.text ?? "")}`),
    _default: (b) => c.darkGray(`[assistant/${b.type}]`),
  };

  export const USER_BLOCK_FMT: FmtTable = {
    text:     (b) => b._isSynthetic
      ? c.darkGray(`\n${trunc(b.text ?? "", 100)}`)
      : `\n${b.text ?? ""}`,
    _default: (b) => c.darkGray(`[user/${b.type}]`),
  };

  export const TOOL_CALL_FMT: FmtTable = {
    Bash:     (b) => fmtToolCall(b, `$ ${trunc(b.input?.command ?? "", 80)}`),
    Read:     (b) => fmtToolCall(b, `• Read(${b.input?.file_path ?? "?"})`),
    Write:    (b) => fmtToolCall(b, `• Write(${b.input?.file_path ?? "?"})`),
    Edit:     (b) => fmtToolCall(b, `• Edit(${b.input?.file_path ?? "?"})`),
    Glob:     (b) => fmtToolCall(b, `• Glob(${b.input?.pattern ?? "?"})`),
    Grep:     (b) => fmtToolCall(b, `• grep ${trunc(b.input?.pattern ?? "?", 30)} ${b.input?.path ?? "."}`),
    Skill:    (b) => fmtToolCall(b, `• Skill(${b.input?.skill ?? "?"})`),
    Agent:    (b) => fmtToolCall(b, `• ${b.input?.subagent_type ?? "Agent"}(${trunc(b.input?.prompt ?? "", 80)})`),
    _default: (b) => fmtToolCall(b, `• ${b.name}(${fmtArgs(b.input)})`),
  };

  export const TOOL_RESULT_FMT: FmtTable = {
    _default: (b) => c.darkGray(`→ ${trunc(toolResultText(b), 100)}`),
    Read:     (b) => c.darkGray(`→ ${fmtCount(toolResultText(b).split("\n").length, "line")}`),
    Edit:     (b) => fmtEditResult(b),
    Skill:    (b) => null,
  };

  export const TOOL_ERROR_FMT: FmtTable = {
    _default: (b) => c.salmon(`! ${trunc(toolResultText(b), 100)}`),
  };

  export const SYSTEM_FMT: FmtTable = {
    init:              { verbose: (m) => c.darkGray(`session: ${m.session_id}`) },
    task_started:      (m) => c.lavender(`  ▶ agent started: ${m.description}`),
    task_progress:     (m) => c.lavender(`  • ${m.description}`),
    task_notification: (m) => c.lavender(`  ◀︎ ${m.status}: ${m.summary}`),
    _default:          { verbose: (m) => c.darkGray(`system/${m.subtype}`) },
  };

  export const MESSAGE_FMT: FmtTable = {
    _empty:           (m) => c.darkGray(`[${m.type} — empty]`),
    result:           (m) => c.darkGray(`\n${fmtStats(Math.round(m.duration_ms / 1000), m.num_turns, m.usage.output_tokens, m.usage.input_tokens)}`),
    rate_limit_event: { verbose: (m) => c.darkGray(`rate limit: status=${m.rate_limit_info?.status ?? "?"}`) },
    _default:         (m) => c.darkGray(`msg: ${m.type}`),
  };

  export const HOOK_FMT: FmtTable = {
    PreToolUse:         { verbose: (h) => c.sageGreen(`hook: pre-tool  ${h.tool_name}(${fmtArgs(h.tool_input ?? {}, 30)})`) },
    PostToolUse:        { verbose: (h) => c.sageGreen(`hook: post-tool ${h.tool_name}  (${h.tool_error == null ? "ok" : "error"})`) },
    PostToolUseFailure: { verbose: (h) => c.sageGreen(`hook: tool fail ${h.tool_name}  ${trunc(String(h.tool_error ?? ""), 50)}`) },
    Notification:       { verbose: (h) => c.sageGreen(`hook: notif "${trunc(String(h.message ?? ""), 60)}"`) },
    UserPromptSubmit:   { verbose: (h) => c.sageGreen(`hook: user prompt "${trunc(String(h.prompt ?? ""), 60)}"`) },
    PermissionRequest:  { verbose: (h) => c.sageGreen(`hook: permission ${h.tool_name ?? h.tool ?? "?"}  → ${h.status ?? h.decision ?? "?"}`) },
    Stop:               { verbose: (h) => c.sageGreen(`hook: stop reason=${h.stop_reason ?? "?"}`) },
    SubagentStart:      { verbose: (h) => c.sageGreen(`hook: subagent start id=${h.agent_id ?? "?"}`) },
    SubagentStop:       { verbose: (h) => c.sageGreen(`hook: subagent stop  id=${h.agent_id ?? "?"}`) },
    TaskCompleted:      { verbose: (h) => c.sageGreen(`hook: task completed id=${h.task_id ?? "?"}`) },
    _default:           { verbose: (h) => c.sageGreen(`hook: ${h._event}`) },
  };

  // ── Printing engine ───────────────────────────────────────────────────────────

  let _statusText = "";
  export let _statusActive = false;
  let _statusInterval: ReturnType<typeof setInterval> | null = null;

  function _clearStatus() {
    if (!_statusActive) return;
    process.stdout.write("\r\x1b[K\x1b[A\x1b[K");
  }

  function _drawStatus() {
    if (!_statusActive) return;
    process.stdout.write("\n\r" + _statusText + "\x1b[K");
  }

  export function startStatus(getText: () => string) {
    _statusActive = true;
    _statusText = getText();
    _drawStatus();
    _statusInterval = setInterval(() => {
      _clearStatus();
      _statusText = getText();
      _drawStatus();
    }, 500);
  }

  export function stopStatus() {
    if (_statusInterval) { clearInterval(_statusInterval); _statusInterval = null; }
    _clearStatus();
    _statusActive = false;
    _statusText = "";
  }

  export function print(line: string | null) {
    if (line === null) return;
    _clearStatus();
    console.log(line);
    _drawStatus();
  }

  export function resolve(table: FmtTable, key: string, data: any): string | null {
    const entry = table[key] ?? table._default;
    if (!entry) return null;
    if (typeof entry === "function") return entry(data);
    const fmt = VERBOSE ? entry.verbose : entry.quiet;
    return fmt ? fmt(data) : null;
  }

  export const toolUseNames = new Map<string, string>();

  export function printBlock(b: any, role: "assistant" | "user", msg?: any) {
    if (b.type === "tool_use") {
      toolUseNames.set(b.id, b.name);
      print(resolve(TOOL_CALL_FMT, b.name, b));
      return;
    }
    if (b.type === "tool_result") {
      const name = toolUseNames.get(b.tool_use_id) ?? "";
      print(resolve(b.is_error ? TOOL_ERROR_FMT : TOOL_RESULT_FMT, name, { ...b, _msg: msg }));
      return;
    }
    const blockFmt = role === "assistant" ? ASSISTANT_BLOCK_FMT : USER_BLOCK_FMT;
    print(resolve(blockFmt, b.type, { ...b, _isSynthetic: msg?.isSynthetic ?? false }));
  }

  export function printMessage(msg: unknown) {
    const m = msg as any;
    if (m.parent_tool_use_id != null) return;

    if (m.type === "system") {
      print(resolve(SYSTEM_FMT, m.subtype, m));
      return;
    }

    if (m.type === "assistant" || m.type === "user") {
      const content: any[] = m.message?.content ?? [];
      if (!content.length) { print(resolve(MESSAGE_FMT, "_empty", m)); return; }
      for (const b of content) printBlock(b, m.type, m);
      return;
    }

    print(resolve(MESSAGE_FMT, m.type, m));
  }

  export function printHook(event: string, input: unknown) {
    print(resolve(HOOK_FMT, event, { ...(input as any), _event: event }));
  }
  ```

- [ ] **Step 2: Run tests — display.ts exists but repl.ts is unchanged, should still pass**

  ```bash
  npm test
  ```

  Expected: all passing (repl.ts hasn't changed yet, display.ts is unused). Confirms no pre-existing breakage before the wiring step.

- [ ] **Step 3: Update `src/repl.ts`** — replace all the moved sections with import+re-export. At the top of the file, replace the display sections with:

  ```typescript
  import {
    W, hr, VERBOSE, setVerbose, c, s,
    trunc, fmtCount, fmtStats, fmtArgs,
    startStatus, stopStatus, print,
    toolUseNames, printMessage, printHook,
  } from "./display.js";
  export {
    VERBOSE, setVerbose,
    trunc, fmtCount, fmtStats, fmtArgs, fmtToolCall, fmtHunk, fmtEditResult, toolResultText,
    mdInline, renderTable, renderMarkdown,
    c, s, W, hr,
    Fmt, FmtEntry, FmtTable,
    ASSISTANT_BLOCK_FMT, USER_BLOCK_FMT, TOOL_CALL_FMT, TOOL_RESULT_FMT,
    TOOL_ERROR_FMT, SYSTEM_FMT, MESSAGE_FMT, HOOK_FMT,
    toolUseNames, resolve, printBlock, printMessage, printHook,
    startStatus, stopStatus, print, _statusActive,
  } from "./display.js";
  ```

  Then delete all the moved sections from `src/repl.ts`: `W`, `hr`, `VERBOSE`, `setVerbose`, colors (`c`), styles (`s`), formatting helpers, markdown renderer, format tables, and the entire printing engine. Keep: `logFull`, hooks (`makeHook`, `ALL_HOOK_EVENTS`, `hooks`), `runQuery`, slash commands, autocomplete, `ask`, `main`.

  Re-exporting from `display.ts` keeps all existing test imports working with no changes to test files — they still import from `src/repl.ts` and get the same live-bound symbols.

- [ ] **Step 4: Run tests**

  ```bash
  npm test
  ```

  Expected: same count as baseline, all passing. If a symbol is missing from the re-export list, the error will name it. Fix and re-run.

- [ ] **Step 5: Commit**

  ```bash
  git add src/display.ts src/repl.ts
  git commit -m "refactor: extract display engine from repl.ts into display.ts"
  ```

- [ ] **Step 6: Push and open PR**

  ```bash
  TOKEN=$(gh auth token) && git remote set-url origin "https://${TOKEN}@github.com/jasoncrawford/brunel.git" && git push -u origin HEAD && git remote set-url origin "https://github.com/jasoncrawford/brunel.git"
  gh pr create --title "refactor: extract display engine into display.ts" --body "Pure refactor — no behavior changes. Moves the display engine (colors, formatting, markdown, printing, status line, VERBOSE flag) from src/repl.ts into a new src/display.ts module. src/repl.ts re-exports everything so existing imports and tests are unaffected."
  ```

  Leave the PR for the user to merge after CI passes.

---

## Chunk 2: Foreman (PR 2)

Depends on Chunk 1 being merged. Adds the `ws` dependency, shared types, and the full foreman implementation.

**File map:**
- Create: `src/types.ts` — shared types used by both foreman and worker
- Create: `src/foreman.ts` — renamed + extended from `src/index.ts`
- Create: `tests/foreman.registry.test.ts` — unit tests for WorkerRegistry
- Create: `tests/foreman.taskqueue.test.ts` — unit tests for TaskQueue
- Create: `tests/foreman.github.test.ts` — unit tests for GitHub API helpers
- Modify: `package.json` — add `ws` dependency, update `npm start` script
- Delete: `src/index.ts` (renamed to `src/foreman.ts`)

### Task 3: Add ws dependency and create src/types.ts

- [ ] **Step 1: Install ws**

  ```bash
  npm install ws && npm install --save-dev @types/ws
  ```

  Expected: `package.json` updated, no errors.

- [ ] **Step 2: Create `src/types.ts`**

  ```typescript
  // ── Shared types for foreman/worker protocol ──────────────────────────────────

  export interface GitHubEvent {
    id: string;           // x-github-delivery header value
    name: string;         // e.g. "check_run", "pull_request_review_comment"
    payload: Record<string, unknown>;
  }

  export interface TaskIssue {
    number: number;
    title: string;
    body: string;
    labels: string[];
    repoUrl: string;
  }

  // Worker → Foreman messages
  export type WorkerMessage =
    | { type: "worker_hello"; workerId: string; taskId?: string; status: "idle" | "busy" }
    | { type: "task_complete"; workerId: string; taskId: string };

  // Foreman → Worker messages
  export type ForemanMessage =
    | { type: "task_assigned"; taskId: string; issue: TaskIssue }
    | { type: "event_notification"; taskId: string; event: GitHubEvent }
    | { type: "standby" };
  ```

- [ ] **Step 3: Commit**

  ```bash
  git add src/types.ts package.json package-lock.json
  git commit -m "feat: add ws dependency and shared protocol types"
  ```

### Task 4: WorkerRegistry — tests then implementation

- [ ] **Step 1: Write failing tests in `tests/foreman.registry.test.ts`**

  ```typescript
  import { describe, it, expect, vi, beforeEach } from "vitest";
  import { WorkerRegistry } from "../src/foreman.js";

  function fakeWs() {
    return { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
  }

  describe("WorkerRegistry", () => {
    let reg: WorkerRegistry;
    beforeEach(() => { reg = new WorkerRegistry(); });

    it("registers a worker and retrieves it", () => {
      reg.register("w1", fakeWs(), "idle");
      expect(reg.get("w1")).toMatchObject({ workerId: "w1", status: "idle" });
    });

    it("getIdleWorker returns an idle worker", () => {
      reg.register("w1", fakeWs(), "idle");
      expect(reg.getIdleWorker()?.workerId).toBe("w1");
    });

    it("getIdleWorker returns null when all busy", () => {
      reg.register("w1", fakeWs(), "busy");
      expect(reg.getIdleWorker()).toBeNull();
    });

    it("assignTask marks worker busy with taskId", () => {
      reg.register("w1", fakeWs(), "idle");
      reg.assignTask("w1", "42");
      const w = reg.get("w1")!;
      expect(w.status).toBe("busy");
      expect(w.currentTaskId).toBe("42");
    });

    it("releaseWorker marks worker idle and clears taskId", () => {
      reg.register("w1", fakeWs(), "busy");
      reg.assignTask("w1", "42");
      reg.releaseWorker("w1");
      const w = reg.get("w1")!;
      expect(w.status).toBe("idle");
      expect(w.currentTaskId).toBeUndefined();
    });

    it("remove deletes the worker", () => {
      reg.register("w1", fakeWs(), "idle");
      reg.remove("w1");
      expect(reg.get("w1")).toBeUndefined();
    });

    it("getWorkerForTask returns worker assigned to that task", () => {
      reg.register("w1", fakeWs(), "idle");
      reg.assignTask("w1", "42");
      expect(reg.getWorkerForTask("42")?.workerId).toBe("w1");
    });

    it("send serializes message and calls ws.send", () => {
      const ws = fakeWs();
      reg.register("w1", ws, "idle");
      reg.send("w1", { type: "standby" });
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "standby" }));
    });
  });
  ```

- [ ] **Step 2: Run tests — expect failures**

  ```bash
  npm test tests/foreman.registry.test.ts
  ```

  Expected: FAIL — `WorkerRegistry` not exported from `src/foreman.ts` yet.

- [ ] **Step 3: Implement `WorkerRegistry` in `src/foreman.ts`**

  Start `src/foreman.ts` as a copy of `src/index.ts`, then add at the top (after imports):

  ```typescript
  import type { WebSocket as WsSocket } from "ws";
  import type { WorkerMessage, ForemanMessage, GitHubEvent } from "./types.js";

  // ── WorkerRegistry ────────────────────────────────────────────────────────────

  interface WorkerState {
    workerId: string;
    ws: WsSocket;
    status: "idle" | "busy";
    currentTaskId?: string;
  }

  export class WorkerRegistry {
    private workers = new Map<string, WorkerState>();

    register(workerId: string, ws: WsSocket, status: "idle" | "busy", taskId?: string) {
      this.workers.set(workerId, { workerId, ws, status, currentTaskId: taskId });
    }

    get(workerId: string): WorkerState | undefined {
      return this.workers.get(workerId);
    }

    remove(workerId: string) {
      this.workers.delete(workerId);
    }

    getIdleWorker(): WorkerState | null {
      for (const w of this.workers.values()) {
        if (w.status === "idle") return w;
      }
      return null;
    }

    getWorkerForTask(taskId: string): WorkerState | null {
      for (const w of this.workers.values()) {
        if (w.currentTaskId === taskId) return w;
      }
      return null;
    }

    assignTask(workerId: string, taskId: string) {
      const w = this.workers.get(workerId);
      if (!w) return;
      w.status = "busy";
      w.currentTaskId = taskId;
    }

    releaseWorker(workerId: string) {
      const w = this.workers.get(workerId);
      if (!w) return;
      w.status = "idle";
      w.currentTaskId = undefined;
    }

    send(workerId: string, msg: ForemanMessage) {
      const w = this.workers.get(workerId);
      if (w?.ws.readyState === 1 /* OPEN */) {
        w.ws.send(JSON.stringify(msg));
      }
    }
  }
  ```

- [ ] **Step 4: Run tests — expect pass**

  ```bash
  npm test tests/foreman.registry.test.ts
  ```

  Expected: all pass.

### Task 5: TaskQueue — tests then implementation

- [ ] **Step 1: Write failing tests in `tests/foreman.taskqueue.test.ts`**

  ```typescript
  import { describe, it, expect, beforeEach } from "vitest";
  import { TaskQueue } from "../src/foreman.js";
  import type { GitHubEvent } from "../src/types.js";

  const baseTask = {
    taskId: "42",
    issueNumber: 42,
    title: "Fix the bug",
    body: "It is broken",
    labels: ["brunel:ready"],
    repoUrl: "https://github.com/test/repo",
  };

  describe("TaskQueue", () => {
    let q: TaskQueue;
    beforeEach(() => { q = new TaskQueue(); });

    it("addTask makes task pending", () => {
      q.addTask(baseTask);
      expect(q.get("42")?.status).toBe("pending");
    });

    it("nextPending returns first pending task and removes it from pending", () => {
      q.addTask(baseTask);
      const t = q.nextPending();
      expect(t?.taskId).toBe("42");
      // Still in map but status changes when assigned
    });

    it("nextPending returns null when no pending tasks", () => {
      expect(q.nextPending()).toBeNull();
    });

    it("assignTask updates status and assignedWorkerId", () => {
      q.addTask(baseTask);
      q.nextPending();
      q.assignTask("42", "w1");
      expect(q.get("42")?.status).toBe("assigned");
      expect(q.get("42")?.assignedWorkerId).toBe("w1");
    });

    it("completeTask updates status", () => {
      q.addTask(baseTask);
      q.assignTask("42", "w1");
      q.completeTask("42");
      expect(q.get("42")?.status).toBe("complete");
    });

    it("queueEvent appends to task eventQueue", () => {
      q.addTask(baseTask);
      const evt: GitHubEvent = { id: "e1", name: "check_run", payload: {} };
      q.queueEvent("42", evt);
      expect(q.get("42")?.eventQueue).toHaveLength(1);
    });

    it("drainEvents returns all events and clears the queue", () => {
      q.addTask(baseTask);
      const evt: GitHubEvent = { id: "e1", name: "check_run", payload: {} };
      q.queueEvent("42", evt);
      const drained = q.drainEvents("42");
      expect(drained).toHaveLength(1);
      expect(q.get("42")?.eventQueue).toHaveLength(0);
    });

    it("getTaskForIssue looks up by issueNumber", () => {
      q.addTask(baseTask);
      expect(q.getTaskForIssue(42)?.taskId).toBe("42");
    });
  });
  ```

- [ ] **Step 2: Run tests — expect failures**

  ```bash
  npm test tests/foreman.taskqueue.test.ts
  ```

  Expected: FAIL.

- [ ] **Step 3: Implement `TaskQueue` in `src/foreman.ts`**

  Add after `WorkerRegistry`:

  ```typescript
  // ── TaskQueue ─────────────────────────────────────────────────────────────────

  interface Task {
    taskId: string;
    issueNumber: number;
    title: string;
    body: string;
    labels: string[];
    repoUrl: string;
    status: "pending" | "assigned" | "complete";
    assignedWorkerId?: string;
    eventQueue: GitHubEvent[];
  }

  export class TaskQueue {
    private tasks = new Map<string, Task>();

    addTask(t: Omit<Task, "status" | "assignedWorkerId" | "eventQueue"> & Partial<Pick<Task, "status" | "eventQueue">>) {
      this.tasks.set(t.taskId, {
        ...t,
        status: t.status ?? "pending",
        eventQueue: t.eventQueue ?? [],
      });
    }

    get(taskId: string): Task | undefined {
      return this.tasks.get(taskId);
    }

    getTaskForIssue(issueNumber: number): Task | undefined {
      for (const t of this.tasks.values()) {
        if (t.issueNumber === issueNumber) return t;
      }
      return undefined;
    }

    nextPending(): Task | null {
      for (const t of this.tasks.values()) {
        if (t.status === "pending") return t;
      }
      return null;
    }

    assignTask(taskId: string, workerId: string) {
      const t = this.tasks.get(taskId);
      if (!t) return;
      t.status = "assigned";
      t.assignedWorkerId = workerId;
    }

    completeTask(taskId: string) {
      const t = this.tasks.get(taskId);
      if (t) t.status = "complete";
    }

    queueEvent(taskId: string, event: GitHubEvent) {
      const t = this.tasks.get(taskId);
      if (t) t.eventQueue.push(event);
    }

    drainEvents(taskId: string): GitHubEvent[] {
      const t = this.tasks.get(taskId);
      if (!t) return [];
      const events = t.eventQueue.slice();
      t.eventQueue = [];
      return events;
    }
  }
  ```

- [ ] **Step 4: Run tests — expect pass**

  ```bash
  npm test tests/foreman.taskqueue.test.ts
  ```

  Expected: all pass.

- [ ] **Step 5: Commit**

  ```bash
  git add src/foreman.ts tests/foreman.registry.test.ts tests/foreman.taskqueue.test.ts
  git commit -m "feat: add WorkerRegistry and TaskQueue to foreman"
  ```

### Task 6: GitHub API startup scan — tests then implementation

- [ ] **Step 1: Write failing tests in `tests/foreman.github.test.ts`**

  ```typescript
  import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
  import { loadIssuesToQueue, labelIssueDone } from "../src/foreman.js";
  import { TaskQueue } from "../src/foreman.js";

  const mockIssues = [
    { number: 1, title: "First issue", body: "body 1", labels: [{ name: "brunel:ready" }] },
    { number: 2, title: "Second issue", body: null, labels: [{ name: "brunel:ready" }] },
  ];

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    process.env.GITHUB_REPO = "owner/repo";
    process.env.GITHUB_TOKEN = "token123";
    process.env.TASK_LABEL = "brunel:ready";
    process.env.DONE_LABEL = "brunel:done";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GITHUB_REPO;
    delete process.env.GITHUB_TOKEN;
  });

  describe("loadIssuesToQueue", () => {
    it("fetches open issues with the task label and adds them to queue", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({
        ok: true,
        json: async () => mockIssues,
      } as any);

      const q = new TaskQueue();
      await loadIssuesToQueue(q);

      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("owner/repo/issues"),
        expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer token123" }) }),
      );
      expect(q.get("1")?.title).toBe("First issue");
      expect(q.get("2")?.body).toBe(""); // null coerced to ""
    });

    it("throws on non-ok response", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 403 } as any);
      await expect(loadIssuesToQueue(new TaskQueue())).rejects.toThrow("403");
    });
  });

  describe("labelIssueDone", () => {
    it("POSTs the done label to the issue", async () => {
      vi.mocked(fetch).mockResolvedValueOnce({ ok: true } as any);
      await labelIssueDone(42);
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("owner/repo/issues/42/labels"),
        expect.objectContaining({ method: "POST" }),
      );
    });
  });
  ```

- [ ] **Step 2: Run tests — expect failures**

  ```bash
  npm test tests/foreman.github.test.ts
  ```

- [ ] **Step 3: Implement `loadIssuesToQueue` and `labelIssueDone` in `src/foreman.ts`**

  ```typescript
  // ── GitHub API helpers ────────────────────────────────────────────────────────
  // Read env vars inside function bodies (not at module load) so that tests can
  // set process.env values before calling the function.

  function ghEnv() {
    return {
      repo:       process.env.GITHUB_REPO ?? "",
      token:      process.env.GITHUB_TOKEN ?? "",
      taskLabel:  process.env.TASK_LABEL ?? "brunel:ready",
      doneLabel:  process.env.DONE_LABEL ?? "brunel:done",
    };
  }

  function ghHeaders(token: string) {
    return {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  export async function loadIssuesToQueue(queue: TaskQueue): Promise<void> {
    const { repo, token, taskLabel } = ghEnv();
    const [owner, repoName] = repo.split("/");
    const url = `https://api.github.com/repos/${owner}/${repoName}/issues?labels=${encodeURIComponent(taskLabel)}&state=open&per_page=100`;
    const res = await fetch(url, { headers: ghHeaders(token) });
    if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
    const issues = await res.json() as Array<{ number: number; title: string; body: string | null; labels: Array<{ name: string }> }>;
    for (const issue of issues) {
      queue.addTask({
        taskId: String(issue.number),
        issueNumber: issue.number,
        title: issue.title,
        body: issue.body ?? "",
        labels: issue.labels.map(l => l.name),
        repoUrl: `https://github.com/${owner}/${repoName}`,
      });
    }
  }

  export async function labelIssueDone(issueNumber: number): Promise<void> {
    const { repo, token, doneLabel } = ghEnv();
    const [owner, repoName] = repo.split("/");
    await fetch(`https://api.github.com/repos/${owner}/${repoName}/issues/${issueNumber}/labels`, {
      method: "POST",
      headers: { ...ghHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ labels: [doneLabel] }),
    });
  }
  ```

- [ ] **Step 4: Run tests — expect pass**

  ```bash
  npm test tests/foreman.github.test.ts
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add src/foreman.ts tests/foreman.github.test.ts
  git commit -m "feat: add GitHub API helpers for startup scan and task completion"
  ```

### Task 7: WebSocket server and worker protocol

This task wires together the WebSocket server, WorkerRegistry, TaskQueue, and the startup flow. It is harder to unit test cleanly, so we focus on integration behaviour and verify manually.

- [ ] **Step 1: Add WebSocket server and worker message handling to `src/foreman.ts`**

  Add imports at the top:
  ```typescript
  import { WebSocketServer } from "ws";
  ```

  Replace the `server.listen(...)` call with:

  ```typescript
  // ── WebSocket server ──────────────────────────────────────────────────────────

  const wss = new WebSocketServer({ noServer: true });
  const registry = new WorkerRegistry();
  const taskQueue = new TaskQueue();

  function tryAssignWork(workerId: string) {
    const task = taskQueue.nextPending();
    if (task) {
      taskQueue.assignTask(task.taskId, workerId);
      registry.assignTask(workerId, task.taskId);
      // Forward any pre-queued events
      const queued = taskQueue.drainEvents(task.taskId);
      registry.send(workerId, {
        type: "task_assigned",
        taskId: task.taskId,
        issue: {
          number: task.issueNumber,
          title: task.title,
          body: task.body,
          labels: task.labels,
          repoUrl: task.repoUrl,
        },
      });
      for (const evt of queued) {
        registry.send(workerId, { type: "event_notification", taskId: task.taskId, event: evt });
      }
    } else {
      registry.send(workerId, { type: "standby" });
    }
  }

  wss.on("connection", (ws) => {
    let workerId = "";

    ws.on("message", (data) => {
      let msg: WorkerMessage;
      try { msg = JSON.parse(data.toString()); } catch { return; }

      if (msg.type === "worker_hello") {
        workerId = msg.workerId;

        if (msg.status === "busy" && msg.taskId) {
          // Reconnecting worker claiming its task
          const existing = taskQueue.get(msg.taskId);
          if (existing && existing.status !== "assigned") {
            // Task is free — worker reclaims it
            registry.register(workerId, ws, "busy", msg.taskId);
            taskQueue.assignTask(msg.taskId, workerId);
            // Forward any queued events
            const queued = taskQueue.drainEvents(msg.taskId);
            for (const evt of queued) {
              registry.send(workerId, { type: "event_notification", taskId: msg.taskId, event: evt });
            }
          } else if (!existing) {
            // Task unknown (e.g. completed while disconnected) — treat as idle
            registry.register(workerId, ws, "idle");
            tryAssignWork(workerId);
          } else {
            // Task already assigned to another worker — standby
            registry.register(workerId, ws, "idle");
            registry.send(workerId, { type: "standby" });
          }
        } else {
          registry.register(workerId, ws, "idle");
          tryAssignWork(workerId);
        }
      }

      if (msg.type === "task_complete") {
        const task = taskQueue.get(msg.taskId);
        if (task) {
          taskQueue.completeTask(msg.taskId);
          labelIssueDone(task.issueNumber).catch(err =>
            console.error("Failed to label issue done:", err)
          );
        }
        registry.releaseWorker(workerId);
        tryAssignWork(workerId);
      }
    });

    ws.on("close", () => {
      if (workerId) registry.remove(workerId);
    });
  });

  server.on("upgrade", (req, socket, head) => {
    if (req.url === "/worker") {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } else {
      socket.destroy();
    }
  });

  server.listen(PORT, async () => {
    console.log(`\nListening on http://localhost:${PORT}/webhook`);
    console.log("WebSocket workers: ws://localhost:" + PORT + "/worker");
    console.log("Waiting for events...\n");
    try {
      await loadIssuesToQueue(taskQueue);
      console.log(`Loaded ${[...Array.from({ length: 0 })].length} pending tasks from GitHub`);
    } catch (err) {
      console.error("Warning: failed to load issues from GitHub:", err);
    }
  });
  ```

- [ ] **Step 2: Update event routing in the webhook handler**

  In the existing `printEvent` / `webhooks.onAny` handler, add routing after printing. Replace the `webhooks.onAny` call with:

  ```typescript
  if (webhooks) {
    webhooks.onAny(({ id, name, payload }) => {
      printEvent(id, name as string, payload);
      routeEventToWorker(id, name as string, payload);
    });
  }
  ```

  Add the routing function before the HTTP server:

  ```typescript
  function routeEventToWorker(id: string, name: string, payload: unknown) {
    const p = payload as Record<string, unknown>;
    const issue = (p.issue ?? p.pull_request) as Record<string, unknown> | undefined;
    const issueNumber = typeof issue?.number === "number" ? issue.number : null;
    if (issueNumber === null) return;

    const evt: GitHubEvent = { id, name, payload: p };
    const task = taskQueue.getTaskForIssue(issueNumber);
    if (!task) return;

    if (task.status === "assigned" && task.assignedWorkerId) {
      registry.send(task.assignedWorkerId, { type: "event_notification", taskId: task.taskId, event: evt });
    } else if (task.status === "pending") {
      taskQueue.queueEvent(task.taskId, evt);
    }
  }
  ```

  Also update the unsigned webhook path to route events:
  ```typescript
  } else {
    const parsed = JSON.parse(rawBody);
    printEvent(id, name, parsed);
    routeEventToWorker(id, name, parsed);
  }
  ```

- [ ] **Step 3: Update `package.json` scripts and rename**

  In `package.json`, change `"start": "tsx src/index.ts"` to `"start": "tsx src/foreman.ts"`.

  Then rename the file:
  ```bash
  git mv src/index.ts src/foreman.ts
  ```

- [ ] **Step 4: Run all tests**

  ```bash
  npm test
  ```

  Expected: all pass (foreman tests + existing tests).

- [ ] **Step 5: Manual smoke test**

  ```bash
  npm start
  ```

  Expected: server starts, "Listening on http://localhost:3000/webhook", "WebSocket workers: ws://localhost:3000/worker". (GitHub scan will fail gracefully if `GITHUB_REPO`/`GITHUB_TOKEN` not set — "Warning: failed to load issues".)

- [ ] **Step 6: Commit and open PR**

  ```bash
  git add src/foreman.ts package.json tests/foreman.registry.test.ts tests/foreman.taskqueue.test.ts tests/foreman.github.test.ts
  git commit -m "feat: add foreman with WorkerRegistry, TaskQueue, WebSocket server, and event routing"
  TOKEN=$(gh auth token) && git remote set-url origin "https://${TOKEN}@github.com/jasoncrawford/brunel.git" && git push -u origin HEAD && git remote set-url origin "https://github.com/jasoncrawford/brunel.git"
  gh pr create --title "feat: add foreman with worker coordination" --body "Adds the foreman process: WorkerRegistry, TaskQueue, GitHub API startup scan, WebSocket server on /worker path, and event routing from webhooks to assigned workers."
  ```

---

## Chunk 3: Worker Mode (PR 3)

Depends on Chunks 1 and 2 being merged. Adds the worker-side components.

**File map:**
- Create: `src/worker-id.ts` — stable UUID persistence
- Create: `src/templates.ts` — prompt templates keyed by event type
- Create: `tests/worker-id.test.ts`
- Create: `tests/templates.test.ts`
- Modify: `src/repl.ts` — add `/task-complete` slash command, `abort` param to `ask()`, `workerMain()`
- Modify: `tests/repl.slash.test.ts` — add `/task-complete` tests
- Modify: `tests/repl.input.test.ts` — add `abort` param tests
- Modify: `package.json` — add `worker` script, update `.env.example`

### Task 8: src/worker-id.ts — tests then implementation

- [ ] **Step 1: Write failing tests in `tests/worker-id.test.ts`**

  ```typescript
  import { describe, it, expect, vi, beforeEach } from "vitest";

  // vi.mock is hoisted by Vitest. worker-id.ts has no module-level state —
  // getWorkerId() always calls fs on each invocation, so no resetModules() needed.
  vi.mock("fs");
  import fs from "fs";
  import { getWorkerId } from "../src/worker-id.js";

  beforeEach(() => {
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(fs.writeFileSync).mockReset();
  });

  describe("getWorkerId", () => {
    it("returns existing id from file", () => {
      vi.mocked(fs.readFileSync).mockReturnValue("existing-uuid\n" as any);
      expect(getWorkerId()).toBe("existing-uuid");
    });

    it("generates and saves a new uuid when file missing", () => {
      vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error("ENOENT"); });
      vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
      const id = getWorkerId();
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(fs.writeFileSync).toHaveBeenCalledWith(".worker-id", id);
    });
  });
  ```

- [ ] **Step 2: Run tests — expect failures**

  ```bash
  npm test tests/worker-id.test.ts
  ```

- [ ] **Step 3: Create `src/worker-id.ts`**

  ```typescript
  import fs from "fs";
  import crypto from "crypto";

  const ID_FILE = ".worker-id";

  export function getWorkerId(): string {
    try {
      return fs.readFileSync(ID_FILE, "utf8").trim();
    } catch {
      const id = crypto.randomUUID();
      fs.writeFileSync(ID_FILE, id);
      return id;
    }
  }
  ```

- [ ] **Step 4: Run tests — expect pass**

  ```bash
  npm test tests/worker-id.test.ts
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add src/worker-id.ts tests/worker-id.test.ts
  git commit -m "feat: add worker-id persistence"
  ```

### Task 9: src/templates.ts — tests then implementation

- [ ] **Step 1: Write failing tests in `tests/templates.test.ts`**

  ```typescript
  import { describe, it, expect } from "vitest";
  import { buildInitialPrompt, buildEventPrompt } from "../src/templates.js";
  import type { GitHubEvent } from "../src/types.js";

  describe("buildInitialPrompt", () => {
    it("includes issue number, title, and body", () => {
      const p = buildInitialPrompt({ number: 42, title: "Fix bug", body: "It crashes", labels: ["bug"], repoUrl: "https://github.com/x/y" });
      expect(p).toContain("#42");
      expect(p).toContain("Fix bug");
      expect(p).toContain("It crashes");
    });

    it("handles empty body gracefully", () => {
      const p = buildInitialPrompt({ number: 1, title: "T", body: "", labels: [], repoUrl: "https://github.com/x/y" });
      expect(p).toBeTruthy();
    });
  });

  describe("buildEventPrompt", () => {
    it("returns multi-event fallback for 2+ events", () => {
      const events: GitHubEvent[] = [
        { id: "e1", name: "check_run", payload: {} },
        { id: "e2", name: "pull_request_review", payload: {} },
      ];
      const p = buildEventPrompt(events);
      expect(p).toContain("Multiple events");
    });

    it("uses check_run template for single CI failure", () => {
      const evt: GitHubEvent = {
        id: "e1", name: "check_run",
        payload: { check_run: { name: "test", conclusion: "failure", output: { summary: "5 tests failed" } } },
      };
      const p = buildEventPrompt([evt]);
      expect(p).toContain("test");
      expect(p).toContain("failure");
      expect(p).toContain("5 tests failed");
    });

    it("uses review template for pull_request_review", () => {
      const evt: GitHubEvent = {
        id: "e1", name: "pull_request_review",
        payload: { pull_request: { number: 5 }, review: { state: "changes_requested", body: "Please fix X" } },
      };
      const p = buildEventPrompt([evt]);
      expect(p).toContain("PR #5");
      expect(p).toContain("Please fix X");
    });

    it("falls back gracefully for unknown event type", () => {
      const evt: GitHubEvent = { id: "e1", name: "deployment", payload: {} };
      expect(() => buildEventPrompt([evt])).not.toThrow();
    });
  });
  ```

- [ ] **Step 2: Run tests — expect failures**

  ```bash
  npm test tests/templates.test.ts
  ```

- [ ] **Step 3: Create `src/templates.ts`**

  ```typescript
  import type { GitHubEvent, TaskIssue } from "./types.js";

  export function buildInitialPrompt(issue: TaskIssue): string {
    return `You have been assigned GitHub issue #${issue.number}: "${issue.title}" in ${issue.repoUrl}.

Issue description:
${issue.body || "(no description)"}

Labels: ${issue.labels.join(", ") || "(none)"}

Please implement this issue. Start by understanding the requirements, then create a feature branch, implement the changes with tests, and open a pull request. Follow the project conventions in CLAUDE.md.`;
  }

  export function buildEventPrompt(events: GitHubEvent[]): string {
    if (events.length !== 1) {
      return "Multiple events have arrived since you last checked. Please review the current state of your PR and respond accordingly.";
    }
    return buildSingleEventPrompt(events[0]);
  }

  function buildSingleEventPrompt(event: GitHubEvent): string {
    const p = event.payload as Record<string, unknown>;

    switch (event.name) {
      case "check_run": {
        const run = p.check_run as Record<string, unknown>;
        const conclusion = run?.conclusion ?? "unknown";
        const output = run?.output as Record<string, unknown> | undefined;
        if (conclusion === "failure" || conclusion === "action_required") {
          return `CI check "${run?.name}" failed (${conclusion}).\n\n${output?.summary ?? ""}`.trim();
        }
        return `CI check "${run?.name}" completed with conclusion: ${conclusion}.`;
      }

      case "pull_request_review": {
        const review = p.review as Record<string, unknown>;
        const pr = p.pull_request as Record<string, unknown>;
        return `A review was submitted on PR #${pr?.number}: state=${review?.state}.\n\n${review?.body ?? ""}`.trim();
      }

      case "pull_request_review_comment": {
        const comment = p.comment as Record<string, unknown>;
        const pr = p.pull_request as Record<string, unknown>;
        return `A review comment was added on PR #${pr?.number} at \`${comment?.path}\`:\n\n${comment?.body ?? ""}`.trim();
      }

      case "issue_comment": {
        const comment = p.comment as Record<string, unknown>;
        const issue = p.issue as Record<string, unknown>;
        return `A comment was added on issue #${issue?.number}:\n\n${comment?.body ?? ""}`.trim();
      }

      default:
        return `GitHub event "${event.name}" received. Please review the current state of your work and respond accordingly.`;
    }
  }
  ```

- [ ] **Step 4: Run tests — expect pass**

  ```bash
  npm test tests/templates.test.ts
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add src/templates.ts tests/templates.test.ts
  git commit -m "feat: add prompt templates for initial task and event types"
  ```

### Task 10: Add /task-complete slash command

- [ ] **Step 1: Add failing test to `tests/repl.slash.test.ts`**

  In the `parseSlashCommand` describe block, add:

  ```typescript
  it("returns task_complete for /task-complete", () => {
    expect(parseSlashCommand("/task-complete")).toEqual({ type: "task_complete" });
  });
  ```

  In the `dispatchInput` describe block, add:

  ```typescript
  it("returns task_complete for /task-complete input", async () => {
    expect(await dispatchInput("/task-complete")).toEqual({ type: "task_complete" });
  });
  ```

- [ ] **Step 2: Run tests — expect failures**

  ```bash
  npm test tests/repl.slash.test.ts
  ```

- [ ] **Step 3: Update `src/repl.ts`**

  In `SlashCommandResult`, add `| { type: "task_complete" }`.

  In `DispatchResult`, add `| { type: "task_complete" }`.

  In `parseSlashCommand`, add before the `return { type: "unknown_command" }` line:
  ```typescript
  if (command === "task-complete") return { type: "task_complete" };
  ```

  In `dispatchInput`, add in the slash handling block:
  ```typescript
  if (slash.type === "task_complete") return slash;
  ```

- [ ] **Step 4: Run tests — expect pass**

  ```bash
  npm test tests/repl.slash.test.ts
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add src/repl.ts tests/repl.slash.test.ts
  git commit -m "feat: add /task-complete slash command"
  ```

### Task 11: Add abort parameter to ask()

When a WebSocket event arrives while the worker is waiting at the user prompt, it should interrupt `ask()` and return the event as the next input. We implement this by adding an optional `abort` promise parameter to `ask()`.

- [ ] **Step 1: Add failing test to `tests/repl.input.test.ts`**

  Find the `ask()` test suite. Add a new test after the existing ones:

  ```typescript
  it("resolves with abort value when abort promise fires first", async () => {
    const stdin = makeStdin();
    replaceStdin(stdin);
    let resolveAbort!: (v: string) => void;
    const abort = new Promise<string>((r) => { resolveAbort = r; });
    const result = ask("> ", undefined, abort);
    // Fire abort before any stdin input
    resolveAbort("__abort__");
    expect(await result).toBe("__abort__");
  });
  ```

- [ ] **Step 2: Run test — expect failure**

  ```bash
  npm test tests/repl.input.test.ts -- --reporter=verbose 2>&1 | tail -20
  ```

- [ ] **Step 3: Update `ask()` signature and implementation in `src/repl.ts`**

  Change the function signature:
  ```typescript
  export function ask(
    promptStr: string,
    getCommands: () => string[] = () => listCommandNames(),
    abort?: Promise<string>,
  ): Promise<string>
  ```

  Inside `ask()`, after the `process.stdout.write(promptStr)` line, add:
  ```typescript
  if (abort) {
    abort.then((value) => {
      if (!done) {
        // Clear current line and submit the abort value
        process.stdout.write("\r\x1b[K");
        submit(value);
      }
    });
  }
  ```

- [ ] **Step 4: Run tests — expect pass**

  ```bash
  npm test tests/repl.input.test.ts
  ```

- [ ] **Step 5: Commit**

  ```bash
  git add src/repl.ts tests/repl.input.test.ts
  git commit -m "feat: add optional abort promise to ask() for worker mode interrupt"
  ```

### Task 12: Add workerMain() to src/repl.ts

> **Dependency:** This task requires `ws` to be installed (done in Task 3, Chunk 2). Do not start this task until Chunk 2 is merged and `npm install` has been run, otherwise the `import { WebSocket } from "ws"` line below will break the entire `repl.ts` module — including all existing tests.

- [ ] **Step 1: Add the import and workerMain function to `src/repl.ts`**

  Add imports at top:
  ```typescript
  import { WebSocket } from "ws";
  import { getWorkerId } from "./worker-id.js";
  import { buildInitialPrompt, buildEventPrompt } from "./templates.js";
  import type { ForemanMessage, GitHubEvent, TaskIssue } from "./types.js";
  ```

  Add `workerMain` before the `if (process.argv[1] === ...)` guard at the bottom:

  ```typescript
  // ── Worker mode ───────────────────────────────────────────────────────────────

  export async function workerMain() {
    const FOREMAN_URL = process.env.FOREMAN_URL ?? "ws://localhost:3000";
    const workerId = getWorkerId();

    // Local event queue — populated by the ws message handler even during runQuery()
    const pendingEvents: GitHubEvent[] = [];
    let currentTaskId: string | undefined;
    let currentSessionId: string | undefined;
    let currentIssue: TaskIssue | undefined;

    // Signalling: when the worker is waiting at the prompt, a WebSocket event
    // can resolve this to interrupt ask() and process the event.
    let resolveWsInput: ((v: string) => void) | null = null;

    process.stdout.write("\x1b[?2004h");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    print(c.sageGreen(hr("═")));
    print(c.skyBlue(s.bold("  Brunel Worker")));
    print(c.lavender(`  Worker ID: ${workerId} | Foreman: ${FOREMAN_URL}`));
    print(c.sageGreen(hr("═")));

    function connectWs(): WebSocket {
      const ws = new WebSocket(FOREMAN_URL);

      ws.on("message", (data) => {
        let msg: ForemanMessage;
        try { msg = JSON.parse(data.toString()); } catch { return; }

        if (msg.type === "task_assigned") {
          currentTaskId = msg.taskId;
          currentIssue = msg.issue;
          currentSessionId = undefined;
          resolveWsInput?.("__task_assigned__");
          resolveWsInput = null;
        } else if (msg.type === "event_notification") {
          pendingEvents.push(msg.event);
          resolveWsInput?.("__event__");
          resolveWsInput = null;
        } else if (msg.type === "standby") {
          print(c.darkGray("  Standby — waiting for tasks..."));
        }
      });

      ws.on("open", () => {
        print(c.sageGreen("  Connected to foreman."));
        ws.send(JSON.stringify({
          type: "worker_hello",
          workerId,
          taskId: currentTaskId,
          status: currentTaskId ? "busy" : "idle",
        }));
      });

      ws.on("close", () => {
        print(c.amber("  Disconnected from foreman. Reconnecting..."));
        setTimeout(() => connectWs(), 3000);
      });

      ws.on("error", () => { /* close will fire, handled above */ });

      return ws;
    }

    let ws = connectWs();

    // Main worker loop
    while (true) {
      // If we have pending events after a query, process them immediately
      if (pendingEvents.length > 0 && currentTaskId && currentIssue) {
        const events = pendingEvents.splice(0);
        const prompt = buildEventPrompt(events);
        currentSessionId = await runQuery(prompt, currentSessionId);
        continue;
      }

      // Wait for next input: user stdin or WebSocket signal
      const wsAbort = new Promise<string>((resolve) => { resolveWsInput = resolve; });
      const input = await ask("\n[worker] > ", listCommandNames, wsAbort);

      if (input === "__task_assigned__" && currentIssue) {
        print(c.lavender(`  Task assigned: #${currentIssue.number} — ${currentIssue.title}`));
        const prompt = buildInitialPrompt(currentIssue);
        currentSessionId = await runQuery(prompt, currentSessionId);
        continue;
      }

      if (input === "__event__") {
        // pendingEvents already populated; loop will process them
        continue;
      }

      if (!input || input === "__abort__") continue;

      const action = await dispatchInput(input);
      if (action.type === "skip") continue;

      if (action.type === "exit") {
        process.stdout.write("\x1b[?2004l\r\n");
        process.stdin.setRawMode(false);
        process.stdin.pause();
        ws.close();
        break;
      }

      if (action.type === "task_complete") {
        if (currentTaskId) {
          ws.send(JSON.stringify({ type: "task_complete", workerId, taskId: currentTaskId }));
          currentTaskId = undefined;
          currentIssue = undefined;
          currentSessionId = undefined;
          print(c.sageGreen("  Task complete. Waiting for next task..."));
        }
        continue;
      }

      if (action.type === "clear") {
        currentSessionId = undefined;
        print("Session cleared.");
        continue;
      }

      if (action.type === "unknown_command") {
        print(c.boldRed(`Unknown command: /${action.command}`));
        continue;
      }

      if (action.type === "query") {
        try {
          currentSessionId = await runQuery(action.prompt, currentSessionId);
        } catch (err) {
          print(c.boldRed(`\nERROR: ${err}`));
        }
      }
    }
  }
  ```

- [ ] **Step 2: Update the entry point guard at the bottom of `src/repl.ts`**

  Change:
  ```typescript
  if (process.argv[1] === fileURLToPath(import.meta.url)) { main(); }
  ```
  To:
  ```typescript
  if (process.argv[1] === fileURLToPath(import.meta.url)) {
    if (process.argv.includes("--worker-mode")) {
      workerMain();
    } else {
      main();
    }
  }
  ```

- [ ] **Step 3: Run all tests**

  ```bash
  npm test
  ```

  Expected: all pass.

- [ ] **Step 4: Commit**

  ```bash
  git add src/repl.ts
  git commit -m "feat: add workerMain() with WebSocket foreman connection and event loop"
  ```

### Task 13: Update package.json and .env.example

- [ ] **Step 1: Add `worker` script to `package.json`**

  ```json
  "worker": "tsx src/repl.ts --worker-mode"
  ```

- [ ] **Step 2: Update `.env.example`** to add new variables:

  ```
  # Foreman
  GITHUB_REPO=owner/repo
  GITHUB_TOKEN=your_token_here
  TASK_LABEL=brunel:ready
  DONE_LABEL=brunel:done

  # Worker
  FOREMAN_URL=ws://localhost:3000
  ```

- [ ] **Step 3: Commit and open PR**

  ```bash
  git add package.json .env.example
  git commit -m "feat: add worker npm script and update .env.example"
  TOKEN=$(gh auth token) && git remote set-url origin "https://${TOKEN}@github.com/jasoncrawford/brunel.git" && git push -u origin HEAD && git remote set-url origin "https://github.com/jasoncrawford/brunel.git"
  gh pr create --title "feat: add worker mode" --body "Adds worker-side components: stable worker ID persistence, prompt templates, /task-complete command, abort-aware ask(), and workerMain() with WebSocket foreman connection and pending event queue."
  ```

### Task 14: Manual integration smoke test

- [ ] **Step 1: Start the foreman**

  In terminal 1:
  ```bash
  GITHUB_REPO=jasoncrawford/brunel GITHUB_TOKEN=<token> npm start
  ```

  Expected: foreman starts, scans GitHub, prints pending task count.

- [ ] **Step 2: Start a worker**

  In terminal 2:
  ```bash
  npm run worker
  ```

  Expected: worker connects, foreman assigns a task (or worker shows "Standby").

- [ ] **Step 3: Verify event routing**

  Trigger a GitHub event on an issue the worker is handling (or use smee to replay one). Verify the foreman receives it and the worker's console shows it was delivered.
