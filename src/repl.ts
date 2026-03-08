import fs from "fs";
import { query, type HookCallback } from "@anthropic-ai/claude-agent-sdk";

// ── Log file ──────────────────────────────────────────────────────────────────

const LOG_FILE = "repl.log";

function logFull(label: string, data: unknown) {
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

function trunc(s: string, n = 80) {
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function fmtCount(count: number, singular_noun: string, plural_noun?: string) {
  const noun = (count === 1) ? singular_noun : (plural_noun ?? `${singular_noun}s`)
  return `${count} ${noun}`
}

function fmtArgs(input: Record<string, unknown>, maxVal = 50): string {
  return Object.entries(input ?? {})
    .map(([k, v]) => `${k}=${trunc(String(v), maxVal)}`)
    .join(", ");
}

function fmtDiff(hunks: any[]): string {
  return hunks.map(hunk => {
    const header = c.darkGray(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    const width = process.stdout.columns ?? 80;
    const lines = (hunk.lines as string[]).map(line => {
      if (line.startsWith("+")) return c.bgGreen(line.padEnd(width));
      if (line.startsWith("-")) return c.bgRed(line.padEnd(width));
      return c.darkGray(line);
    });
    return [header, ...lines].join("\n");
  }).join("\n");
}

function toolResultText(b: any): string {
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

const c = {
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

const s = {
  bold:          (s: string) => `\x1b[1m${s}\x1b[22m`,
  dim:           (s: string) => `\x1b[2m${s}\x1b[22m`,
  italic:        (s: string) => `\x1b[3m${s}\x1b[23m`,
  underline:     (s: string) => `\x1b[4m${s}\x1b[24m`,
  strikethrough: (s: string) => `\x1b[9m${s}\x1b[29m`,
};

// ── Markdown renderer ─────────────────────────────────────────────────────────
// Handles the subset of Markdown Claude commonly produces.
// Uses only targeted-reset style helpers (s.*) so the caller's color is preserved.

function mdInline(text: string): string {
  text = text.replace(/\*\*(.+?)\*\*/gs,  (_, t) => s.bold(t));
  text = text.replace(/__(.+?)__/gs,      (_, t) => s.bold(t));
  // Note: strikethrough and italic are left as raw Markdown (~~text~~, *text*)
  // because Terminal.app doesn't render \x1b[9m or \x1b[3m.
  text = text.replace(/`([^`]+)`/g,       (_, t) => s.bold(s.underline(t)));
  return text;
}

function renderMarkdown(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inCode = false;
  const codeLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("```")) {
      if (!inCode) { inCode = true; codeLines.length = 0; }
      else         { inCode = false; out.push(codeLines.map(l => "  " + l).join("\n")); }
      continue;
    }
    if (inCode) { codeLines.push(line); continue; }

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

  return out.join("\n");
}

// ── FORMATS ───────────────────────────────────────────────────────────────────
// Edit these to change what gets printed to the console.
// Each entry is either a single Fmt (same in both modes) or { quiet, verbose }.
// Return null to suppress output entirely for that type.

type Fmt = (data: any) => string | null;
type FmtEntry = Fmt | { quiet?: Fmt; verbose?: Fmt };
type FmtTable = Record<string, FmtEntry>;

// Content blocks within assistant/user messages
// Engine injects: _role ("assistant" | "user")
// tool_use and tool_result are handled separately via TOOL_CALL_FMT / TOOL_RESULT_FMT.
const BLOCK_FMT: FmtTable = {
  thinking: (b) => c.gray(`\n${renderMarkdown(b.thinking ?? "")}`),
  text:     (b) => c.skyBlue(`\n${renderMarkdown(b.text ?? "")}`),
  _default: (b) => c.darkGray(`[${b._role}/${b.type}]`),
};

// Tool call formatters, keyed by tool name. _default is the generic fallback.
const TOOL_CALL_FMT: FmtTable = {
  Bash:     (b) => c.sageGreen(`\n$ ${trunc(b.input?.command ?? "", 80)}`) + (b.input?.description ? c.gray(` # ${b.input.description}`) : ""),
  Read:     (b) => c.sageGreen(`\n• Read(${b.input?.file_path ?? "?"})`),
  Write:    (b) => c.sageGreen(`\n• Write(${b.input?.file_path ?? "?"})`),
  Edit:     (b) => c.sageGreen(`\n• Edit(${b.input?.file_path ?? "?"})`),
  Glob:     (b) => c.sageGreen(`\n• Glob(${b.input?.pattern ?? "?"})`),
  Grep:     (b) => c.sageGreen(`\n• grep ${trunc(b.input?.pattern ?? "?", 30)} ${b.input?.path ?? "."}`),
  _default: (b) => c.sageGreen(`\n• ${b.name}(${fmtArgs(b.input)})`),
};

// Tool success result formatters, keyed by tool name. _default is the generic fallback.
const TOOL_RESULT_FMT: FmtTable = {
  _default: (b) => c.sageGreen(`→ ${trunc(toolResultText(b), 100)}`),
  Read:     (b) => c.darkGray(`→ ${fmtCount(toolResultText(b).split("\n").length, "line")}`),
  Edit:     (b) => {
    const patch = b._msg?.tool_use_result?.structuredPatch;
    return (patch && patch.length > 0) ? fmtDiff(patch) : c.sageGreen(`→ ${trunc(toolResultText(b), 100)}`);
  },
};

// Tool error result formatters, keyed by tool name. _default is the generic fallback.
const TOOL_ERROR_FMT: FmtTable = {
  _default: (b) => c.salmon(`! ${trunc(toolResultText(b), 100)}`),
};

// system/* message subtypes
// Engine injects: subtype is already at m.subtype
const SYSTEM_FMT: FmtTable = {
  init:              { verbose: (m) => c.darkGray(`session: ${m.session_id}`) },
  task_started:      (m) => c.lavender(`  ▶ agent started: ${m.description}`),
  task_progress:     (m) => c.lavender(`  • ${m.description}`),
  task_notification: (m) => c.lavender(`  ◀︎ ${m.status}: ${m.summary}`),
  _default:          { verbose: (m) => c.darkGray(`system/${m.subtype}`) },
};

// Top-level message types (other than system, assistant, user)
// Engine injects: type is already at m.type
const MESSAGE_FMT: FmtTable = {
  _empty:           (m) => c.darkGray(`[${m.type} — empty]`),
  result:           (m) => c.darkGray(`\n${fmtCount(m.num_turns, 'turn')}, ${m.duration_ms/1000}s, tokens: ${m.usage.input_tokens} in / ${m.usage.output_tokens} out`),
  rate_limit_event: { verbose: (m) => c.darkGray(`rate limit: status=${m.rate_limit_info?.status ?? "?"}`) },
  _default:         (m) => c.darkGray(`msg: ${m.type}`),
};

// Hook events
// Engine injects: _event (the hook event name)
const HOOK_FMT: FmtTable = {
  PreToolUse:         { verbose: (h) => c.yellow(`hook: pre-tool  ${h.tool_name}(${fmtArgs(h.tool_input ?? {}, 30)})`) },
  PostToolUse:        { verbose: (h) => c.yellow(`hook: post-tool ${h.tool_name}  (${h.tool_error == null ? "ok" : "error"})`) },
  PostToolUseFailure: { verbose: (h) => c.yellow(`hook: tool fail ${h.tool_name}  ${trunc(String(h.tool_error ?? ""), 50)}`) },
  Notification:       { verbose: (h) => c.yellow(`hook: notif "${trunc(String(h.message ?? ""), 60)}"`) },
  UserPromptSubmit:   { verbose: (h) => c.yellow(`hook: user prompt "${trunc(String(h.prompt ?? ""), 60)}"`) },
  PermissionRequest:  { verbose: (h) => c.yellow(`hook: permission ${h.tool_name ?? h.tool ?? "?"}  → ${h.status ?? h.decision ?? "?"}`) },
  Stop:               { verbose: (h) => c.yellow(`hook: stop reason=${h.stop_reason ?? "?"}`) },
  SubagentStart:      { verbose: (h) => c.yellow(`hook: subagent start id=${h.agent_id ?? "?"}`) },
  SubagentStop:       { verbose: (h) => c.yellow(`hook: subagent stop  id=${h.agent_id ?? "?"}`) },
  TaskCompleted:      { verbose: (h) => c.yellow(`hook: task completed id=${h.task_id ?? "?"}`) },
  _default:           { verbose: (h) => c.yellow(`hook: ${h._event}`) },
};

// ── Printing engine ───────────────────────────────────────────────────────────

function print(line: string | null) {
  if (line !== null) console.log(line);
}

function resolve(table: FmtTable, key: string, data: any): string | null {
  const entry = table[key] ?? table._default;
  if (!entry) return null;
  if (typeof entry === "function") return entry(data);
  const fmt = VERBOSE ? entry.verbose : entry.quiet;
  return fmt ? fmt(data) : null;
}

// Maps tool_use_id → tool name so tool_result blocks can look up their tool.
const toolUseNames = new Map<string, string>();

function printBlock(b: any, role: "assistant" | "user", msg?: any) {
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
  print(resolve(BLOCK_FMT, b.type, { ...b, _role: role }));
}

function printMessage(msg: unknown) {
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

function printHook(event: string, input: unknown) {
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

// ── Config ────────────────────────────────────────────────────────────────────

const BYPASS = process.argv.includes("--dangerously-skip-permissions");
const VERBOSE = process.argv.includes("--verbose");
const PERMISSION_MODE = BYPASS ? "bypassPermissions" : "acceptEdits";

// ── REPL ──────────────────────────────────────────────────────────────────────

async function runQuery(prompt: string, sessionId: string | undefined) {
  logFull("QUERY", { prompt, sessionId });

  let capturedSessionId = sessionId;

  for await (const message of query({
    prompt,
    options: {
      cwd: process.cwd(),
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["user", "project"],
      permissionMode: PERMISSION_MODE,
      ...(BYPASS ? { allowDangerouslySkipPermissions: true } : {}),
      ...(sessionId ? { resume: sessionId } : {}),
      hooks,
    },
  })) {
    logFull("MESSAGE", message);

    const m = message as any;

    if (m.type === "system" && m.subtype === "init" && !capturedSessionId) {
      capturedSessionId = m.session_id;
    }

    printMessage(message);
  }

  return capturedSessionId;
}

// ── Raw input with bracketed paste support ────────────────────────────────────

// Bracketed paste mode: the terminal wraps pasted text in escape markers
// (\x1b[200~ ... \x1b[201~), letting us collect it as a single input
// rather than having each newline submit a separate prompt.

function ask(promptStr: string): Promise<string> {
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

  print(hr("═"));
  print("  Claude Agent SDK REPL");
  print(`  Permissions: ${PERMISSION_MODE} | Output: ${VERBOSE ? "verbose" : "quiet"} | Log: ${LOG_FILE}`);
  print(`  Type 'exit' to quit, 'reset' to start a new session.`);
  print(hr("═"));

  while (true) {
    const input = await ask("\n> ");

    if (!input) continue;
    if (input === "exit") { process.stdout.write("\x1b[?2004l\r\n"); break; }

    if (input === "reset") {
      sessionId = undefined;
      print("Session reset.");
      continue;
    }

    try {
      sessionId = await runQuery(input, sessionId);
    } catch (err) {
      console.error(c.boldRed(`\nERROR: ${err}`));
      logFull("ERROR", err instanceof Error ? { message: err.message, stack: err.stack } : err);
    }
  }
}

main();
