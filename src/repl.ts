import fs from "fs";
import { fileURLToPath } from "url";
import { query, type HookCallback } from "@anthropic-ai/claude-agent-sdk";

// ── Log file ──────────────────────────────────────────────────────────────────

const LOG_FILE = "repl.log";

export function logFull(label: string, data: unknown) {
  const entry =
    `\n${"=".repeat(70)}\n` +
    `${new Date().toISOString()}  ${label}\n` +
    `${"-".repeat(70)}\n` +
    JSON.stringify(data, null, 2) +
    "\n";
  fs.appendFileSync(LOG_FILE, entry);
}

// ── Formatting helpers ────────────────────────────────────────────────────────

const W = 70;
const hr = (ch = "─") => ch.repeat(W);

export function trunc(s: string, n = 80) {
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function fmtCount(count: number, singular_noun: string, plural_noun?: string) {
  const noun = (count === 1) ? singular_noun : (plural_noun ?? `${singular_noun}s`)
  return `${count} ${noun}`
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

// ── Markdown renderer ─────────────────────────────────────────────────────────
// Handles the subset of Markdown Claude commonly produces.
// Uses only targeted-reset style helpers (s.*) so the caller's color is preserved.

export function mdInline(text: string): string {
  text = text.replace(/\*\*(.+?)\*\*/gs,  (_, t) => s.bold(t));
  text = text.replace(/__(.+?)__/gs,      (_, t) => s.bold(t));
  // Note: strikethrough and italic are left as raw Markdown (~~text~~, *text*)
  // because Terminal.app doesn't render \x1b[9m or \x1b[3m.
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
// Edit these to change what gets printed to the console.
// Each entry is either a single Fmt (same in both modes) or { quiet, verbose }.
// Return null to suppress output entirely for that type.

export type Fmt = (data: any) => string | null;
export type FmtEntry = Fmt | { quiet?: Fmt; verbose?: Fmt };
export type FmtTable = Record<string, FmtEntry>;

// Content blocks within assistant messages.
// tool_use and tool_result are handled separately via TOOL_CALL_FMT / TOOL_RESULT_FMT.
export const ASSISTANT_BLOCK_FMT: FmtTable = {
  thinking: (b) => c.gray(`\n${renderMarkdown(b.thinking ?? "")}`),
  text:     (b) => c.yellow(`\n${renderMarkdown(b.text ?? "")}`),
  _default: (b) => c.darkGray(`[assistant/${b.type}]`),
};

// Content blocks within user messages.
export const USER_BLOCK_FMT: FmtTable = {
  text:     (b) => b._isSynthetic
    ? c.darkGray(`\n${trunc(b.text ?? "", 100)}`)
    : `\n${b.text ?? ""}`,
  _default: (b) => c.darkGray(`[user/${b.type}]`),
};

// Tool call formatters, keyed by tool name. _default is the generic fallback.
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

// Tool success result formatters, keyed by tool name. _default is the generic fallback.
export const TOOL_RESULT_FMT: FmtTable = {
  _default: (b) => c.darkGray(`→ ${trunc(toolResultText(b), 100)}`),
  Read:     (b) => c.darkGray(`→ ${fmtCount(toolResultText(b).split("\n").length, "line")}`),
  Edit:     (b) => fmtEditResult(b),
  Skill:    (b) => null,
};

// Tool error result formatters, keyed by tool name. _default is the generic fallback.
export const TOOL_ERROR_FMT: FmtTable = {
  _default: (b) => c.salmon(`! ${trunc(toolResultText(b), 100)}`),
};

// system/* message subtypes
// Engine injects: subtype is already at m.subtype
export const SYSTEM_FMT: FmtTable = {
  init:              { verbose: (m) => c.darkGray(`session: ${m.session_id}`) },
  task_started:      (m) => c.lavender(`  ▶ agent started: ${m.description}`),
  task_progress:     (m) => c.lavender(`  • ${m.description}`),
  task_notification: (m) => c.lavender(`  ◀︎ ${m.status}: ${m.summary}`),
  _default:          { verbose: (m) => c.darkGray(`system/${m.subtype}`) },
};

// Top-level message types (other than system, assistant, user)
// Engine injects: type is already at m.type
export const MESSAGE_FMT: FmtTable = {
  _empty:           (m) => c.darkGray(`[${m.type} — empty]`),
  result:           (m) => c.darkGray(`\n${fmtStats(Math.round(m.duration_ms / 1000), m.num_turns, m.usage.output_tokens, m.usage.input_tokens)}`),
  rate_limit_event: { verbose: (m) => c.darkGray(`rate limit: status=${m.rate_limit_info?.status ?? "?"}`) },
  _default:         (m) => c.darkGray(`msg: ${m.type}`),
};

// Hook events
// Engine injects: _event (the hook event name)
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

// Status line — a live-updating line shown at the bottom while the agent works.
// Each call to print() clears it, logs the line, then redraws it.
// stopStatus() clears it permanently (call before printing the final result line).

let _statusText = "";
export let _statusActive = false;
let _statusInterval: ReturnType<typeof setInterval> | null = null;

function _clearStatus() {
  if (!_statusActive) return;
  // Cursor is at end of status text (line L+1). Clear L+1, move up, clear L.
  process.stdout.write("\r\x1b[K\x1b[A\x1b[K");
  // Cursor is now at start of L.
}

function _drawStatus() {
  if (!_statusActive) return;
  // Cursor is at start of L. Write blank line L, then status on L+1.
  process.stdout.write("\n\r" + _statusText + "\x1b[K");
  // Cursor is now at end of status text on L+1.
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

// Maps tool_use_id → tool name so tool_result blocks can look up their tool.
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

  // Suppress messages from subagents (they have a non-null parent_tool_use_id).
  // Task progress system messages are top-level and don't have this field.
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

// ── Hook factory ──────────────────────────────────────────────────────────────

function makeHook(event: string): HookCallback {
  return async (input) => {
    logFull(`HOOK ${event}`, input);
    printHook(event, input);
    return {};
  };
}

const ALL_HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "Notification",
  "UserPromptSubmit",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PermissionRequest",
  "Setup",
  "TeammateIdle",
  "TaskCompleted",
  "ConfigChange",
] as const;

type HookEvent = (typeof ALL_HOOK_EVENTS)[number];

const hooks = Object.fromEntries(
  ALL_HOOK_EVENTS.map((event) => [
    event,
    [{ matcher: ".*", hooks: [makeHook(event)] }],
  ])
) as Record<HookEvent, [{ matcher: string; hooks: [HookCallback] }]>;

// ── Slash commands ────────────────────────────────────────────────────────────

export type SlashCommandResult =
  | { type: "exit" }
  | { type: "clear" }
  | { type: "unknown_command"; command: string };

/**
 * Parse a slash command from raw user input.
 * Returns null if the input is not a slash command.
 */
export function parseSlashCommand(input: string): SlashCommandResult | null {
  if (!input.startsWith("/")) return null;
  const command = input.slice(1).split(/\s+/)[0];
  if (!command) return null;
  if (command === "exit") return { type: "exit" };
  if (command === "clear") return { type: "clear" };
  return { type: "unknown_command", command };
}

/**
 * Convert a slash command name to its file path under ~/.claude/commands/.
 * Colons become path separators: "foo:bar" → ~/.claude/commands/foo/bar.md
 */
export function resolveCommandFilePath(command: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const rel = command.replace(/:/g, "/");
  return `${home}/.claude/commands/${rel}.md`;
}

/**
 * Load a custom slash command from disk, returning the file content as the
 * query prompt, or null if the file does not exist.
 * The readFile parameter is injectable for testing.
 */
export function loadCommandFile(
  command: string,
  readFile: (path: string) => string | null = defaultReadFile,
): string | null {
  const filePath = resolveCommandFilePath(command);
  return readFile(filePath);
}

function defaultReadFile(path: string): string | null {
  try {
    return fs.readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export type DispatchResult =
  | { type: "skip" }
  | { type: "exit" }
  | { type: "clear" }
  | { type: "query"; prompt: string }
  | { type: "unknown_command"; command: string };

/**
 * Dispatch user input to the appropriate REPL action.
 * readFile is injectable for testing.
 */
export async function dispatchInput(
  input: string,
  readFile: (path: string) => string | null = defaultReadFile,
): Promise<DispatchResult> {
  if (!input) return { type: "skip" };

  const slash = parseSlashCommand(input);
  if (slash) {
    if (slash.type === "exit" || slash.type === "clear") return slash;
    // unknown_command: look up file
    const { command } = slash;
    const content = loadCommandFile(command, readFile);
    if (content === null) return { type: "unknown_command", command };
    const args = input.slice(1 + command.length).trim();
    const prompt = args ? `${content}\n${args}` : content;
    return { type: "query", prompt };
  }

  return { type: "query", prompt: input };
}

// ── Autocomplete ─────────────────────────────────────────────────────────────

/**
 * Filter commands by prefix. Returns commands that start with prefix.
 * Empty prefix returns all commands. Preserves input order.
 */
export function matchCommands(prefix: string, commands: string[]): string[] {
  return commands.filter(cmd => cmd.startsWith(prefix));
}

// ── Config ────────────────────────────────────────────────────────────────────

const BYPASS = process.argv.includes("--dangerously-skip-permissions");
export let VERBOSE = process.argv.includes("--verbose");
export function setVerbose(v: boolean) { VERBOSE = v; }
const PERMISSION_MODE = BYPASS ? "bypassPermissions" : "acceptEdits";

// ── REPL ──────────────────────────────────────────────────────────────────────

export async function runQuery(prompt: string, sessionId: string | undefined) {
  logFull("QUERY", { prompt, sessionId });

  const startTime = Date.now();
  // Accumulate stats from stream_event messages to show in the status line.
  // message_delta.usage.output_tokens is cumulative per message, so we sum
  // completed messages and track the current one separately.
  const stats = { turns: 0, inputTokens: 0, completedOutputTokens: 0, currentOutputTokens: 0 };
  startStatus(() => {
    const secs = Math.floor((Date.now() - startTime) / 1000);
    const outTokens = stats.completedOutputTokens + stats.currentOutputTokens;
    return c.darkGray(`Working… ${fmtStats(secs, stats.turns || undefined, outTokens || undefined, stats.inputTokens || undefined)}`);
  });

  let capturedSessionId = sessionId;

  for await (const message of query({
    prompt,
    options: {
      cwd: process.cwd(),
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["user", "project"],
      permissionMode: PERMISSION_MODE,
      includePartialMessages: true,
      ...(BYPASS ? { allowDangerouslySkipPermissions: true } : {}),
      ...(sessionId ? { resume: sessionId } : {}),
      hooks,
    },
  })) {
    const m = message as any;

    if (!(m.type === "stream_event" && m.event?.type === "content_block_delta")) {
      logFull("MESSAGE", message);
    }

    if (m.type === "system" && m.subtype === "init" && !capturedSessionId) {
      capturedSessionId = m.session_id;
    }

    // Extract turn count and token totals from streaming events.
    if (m.type === "stream_event") {
      if (m.parent_tool_use_id == null) {
        const ev = m.event;
        if (ev.type === "message_start")       { stats.turns++; stats.inputTokens += ev.message?.usage?.input_tokens ?? 0; }
        if (ev.type === "message_delta")       stats.currentOutputTokens = ev.usage?.output_tokens ?? stats.currentOutputTokens;
        if (ev.type === "message_stop")        { stats.completedOutputTokens += stats.currentOutputTokens; stats.currentOutputTokens = 0; }
      }
      continue; // stream events are display-only; don't pass to printMessage
    }

    // Stop the status line before printing the result so it transitions
    // cleanly into the permanent summary line.
    if (m.type === "result") stopStatus();

    printMessage(message);
  }

  stopStatus(); // no-op if result message already stopped it
  return capturedSessionId;
}

// ── Raw input with bracketed paste support ────────────────────────────────────

// Bracketed paste mode: the terminal wraps pasted text in escape markers
// (\x1b[200~ ... \x1b[201~), letting us collect it as a single input
// rather than having each newline submit a separate prompt.

export function ask(promptStr: string): Promise<string> {
  return new Promise((resolve) => {
    let buffer = "";
    let pasteBuffer = "";
    let inPaste = false;
    let done = false;

    process.stdout.write(promptStr);

    function submit(value: string) {
      if (done) return;
      done = true;
      process.stdout.write("\r\n");
      process.stdin.removeListener("data", onData);
      resolve(value.trim());
    }

    function exit() {
      process.stdout.write("\x1b[?2004l\r\n");
      process.exit(0);
    }

    let cursor = 0; // current cursor position within buffer

    // Write suffix from cursor, clear trailing chars, reposition cursor
    function redrawSuffix() {
      const rest = buffer.slice(cursor);
      process.stdout.write(rest + "\x1b[K");
      if (rest.length) process.stdout.write(`\x1b[${rest.length}D`);
    }

    function insert(ch: string) {
      buffer = buffer.slice(0, cursor) + ch + buffer.slice(cursor);
      cursor++;
      // Write ch + everything after it, then move back to just after ch
      const rest = buffer.slice(cursor);
      process.stdout.write(ch + rest + "\x1b[K");
      if (rest.length) process.stdout.write(`\x1b[${rest.length}D`);
    }

    function deleteBack() {
      if (cursor === 0) return;
      buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
      cursor--;
      process.stdout.write("\b");
      redrawSuffix();
    }

    function moveTo(pos: number) {
      pos = Math.max(0, Math.min(buffer.length, pos));
      if (pos === cursor) return;
      const delta = pos - cursor;
      process.stdout.write(delta < 0 ? `\x1b[${-delta}D` : `\x1b[${delta}C`);
      cursor = pos;
    }

    function killToEnd() {
      buffer = buffer.slice(0, cursor);
      process.stdout.write("\x1b[K");
    }

    function killToStart() {
      const rest = buffer.slice(cursor);
      buffer = rest;
      if (cursor) process.stdout.write(`\x1b[${cursor}D`);
      cursor = 0;
      redrawSuffix();
    }

    function deleteWord() {
      if (cursor === 0) return;
      let pos = cursor;
      while (pos > 0 && buffer[pos - 1] === " ") pos--;
      while (pos > 0 && buffer[pos - 1] !== " ") pos--;
      buffer = buffer.slice(0, pos) + buffer.slice(cursor);
      if (cursor - pos) process.stdout.write(`\x1b[${cursor - pos}D`);
      cursor = pos;
      redrawSuffix();
    }

    function moveWordLeft() {
      let pos = cursor;
      while (pos > 0 && buffer[pos - 1] === " ") pos--;
      while (pos > 0 && buffer[pos - 1] !== " ") pos--;
      moveTo(pos);
    }

    function moveWordRight() {
      let pos = cursor;
      while (pos < buffer.length && buffer[pos] === " ") pos++;
      while (pos < buffer.length && buffer[pos] !== " ") pos++;
      moveTo(pos);
    }

    function processTyped(data: string) {
      // Substitute known sequences with placeholder chars before stripping
      data = data.replace(/\x1b\[1;3D/g, "\x1c"); // iTerm2 option+left  → 0x1C
      data = data.replace(/\x1b\[1;3C/g, "\x1d"); // iTerm2 option+right → 0x1D
      data = data.replace(/\x1b\[D/g,    "\x1e"); // left arrow           → 0x1E
      data = data.replace(/\x1b\[C/g,    "\x1f"); // right arrow          → 0x1F
      data = data.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""); // strip remaining CSI
      data = data.replace(/\x1bb/g,      "\x1c"); // Terminal.app option+left
      data = data.replace(/\x1bf/g,      "\x1d"); // Terminal.app option+right
      data = data.replace(/\x1b./gs, "");          // strip remaining escapes

      for (const ch of data) {
        const code = ch.charCodeAt(0);
        if      (ch === "\r" || ch === "\n")          { submit(buffer); return; }
        else if (ch === "\x7f" || ch === "\x08")      { deleteBack(); }
        else if (ch === "\x03") { process.stdout.write("^C"); exit(); }
        else if (ch === "\x04") { if (!buffer) exit(); }
        else if (ch === "\x01")                       { moveTo(0); }             // ^A
        else if (ch === "\x05")                       { moveTo(buffer.length); } // ^E
        else if (ch === "\x0b")                       { killToEnd(); }           // ^K
        else if (ch === "\x15")                       { killToStart(); }         // ^U
        else if (ch === "\x17")                       { deleteWord(); }          // ^W
        else if (ch === "\x1c")                       { moveWordLeft(); }        // option+←
        else if (ch === "\x1d")                       { moveWordRight(); }       // option+→
        else if (ch === "\x1e")                       { moveTo(cursor - 1); }   // ←
        else if (ch === "\x1f")                       { moveTo(cursor + 1); }   // →
        else if (code >= 32)                          { insert(ch); }
      }
    }

    function normalizePaste(s: string) {
      return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    }

    function insertPaste(str: string) {
      buffer = buffer.slice(0, cursor) + str + buffer.slice(cursor);
      cursor += str.length;
      // Echo with \r\n... for newlines, then redraw any suffix after cursor
      process.stdout.write(str.split("\n").join("\r\n... "));
      redrawSuffix();
    }

    function onData(chunk: string) {
      if (inPaste) {
        const end = chunk.indexOf("\x1b[201~");
        if (end !== -1) {
          pasteBuffer += chunk.slice(0, end);
          inPaste = false;
          const normalized = normalizePaste(pasteBuffer);
          pasteBuffer = "";
          insertPaste(normalized);
        } else {
          pasteBuffer += chunk;
        }
        return;
      }

      const start = chunk.indexOf("\x1b[200~");
      if (start !== -1) {
        processTyped(chunk.slice(0, start));
        const rest = chunk.slice(start + 6);
        const end = rest.indexOf("\x1b[201~");
        if (end !== -1) {
          insertPaste(normalizePaste(rest.slice(0, end)));
        } else {
          pasteBuffer = rest;
          inPaste = true;
        }
        return;
      }

      processTyped(chunk);
    }

    process.stdin.on("data", onData);
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  process.stdout.write("\x1b[?2004h"); // enable bracketed paste mode
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  let sessionId: string | undefined;

  print(c.sageGreen(hr("═")));
  print(c.skyBlue(s.bold("  Claude Agent SDK REPL")));
  print(c.lavender(`  Permissions: ${PERMISSION_MODE} | Output: ${VERBOSE ? "verbose" : "quiet"} | Log: ${LOG_FILE}`));
  print(c.lavender(`  Type /exit to quit, /clear to start a new session.`));
  print(c.sageGreen(hr("═")));

  while (true) {
    const input = await ask("\n> ");

    const action = await dispatchInput(input);

    if (action.type === "skip") continue;

    if (action.type === "exit") {
      process.stdout.write("\x1b[?2004l\r\n");
      process.stdin.setRawMode(false);
      process.stdin.pause();
      break;
    }

    if (action.type === "clear") {
      sessionId = undefined;
      print("Session cleared.");
      continue;
    }

    if (action.type === "unknown_command") {
      print(c.boldRed(`Unknown command: /${action.command}`));
      continue;
    }

    try {
      sessionId = await runQuery(action.prompt, sessionId);
    } catch (err) {
      console.error(c.boldRed(`\nERROR: ${err}`));
      logFull("ERROR", err instanceof Error ? { message: err.message, stack: err.stack } : err);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) { main(); }
