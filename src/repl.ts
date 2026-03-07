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

function fmtArgs(input: Record<string, unknown>, maxVal = 50): string {
  return Object.entries(input ?? {})
    .map(([k, v]) => `${k}=${trunc(String(v), maxVal)}`)
    .join(", ");
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

// ── FORMATS ───────────────────────────────────────────────────────────────────
// Edit these to change what gets printed to the console.
// Each function receives the raw SDK data and returns a string to print.
// Return null to suppress output for that type.

type Fmt = (data: any) => string | null;

// Content blocks within assistant/user messages
const BLOCK_FMT: Record<string, Fmt> = {
  thinking:    (b) => `\n[thinking]\n${b.thinking ?? ""}\n[/thinking]\n`,
  text:        (b) => String(b.text ?? ""),
  tool_use:    (b) => `>> ${b.name}(${fmtArgs(b.input)})`,
  tool_result: (b) => (b.is_error ? `!! ` : `<< `) + trunc(toolResultText(b), 100),
};

// system/* message subtypes
const SYSTEM_FMT: Record<string, Fmt> = {
  init:              (m) => `session  ${m.session_id}`,
  task_started:      (m) => `task started  id=${m.task_id}`,
  task_progress:     (m) => `task progress  turns=${m.turns ?? "?"} tools=${m.tool_use_count ?? "?"}`,
  task_notification: (m) => `task  ${trunc(String(m.message ?? ""), 70)}`,
};

// Hook events
const HOOK_FMT: Record<string, Fmt> = {
  PreToolUse:         (h) => `hook pre   ${h.tool_name}(${fmtArgs(h.tool_input ?? {}, 30)})`,
  PostToolUse:        (h) => `hook post  ${h.tool_name}  (${h.tool_error == null ? "ok" : "error"})`,
  PostToolUseFailure: (h) => `hook fail  ${h.tool_name}  ${trunc(String(h.tool_error ?? ""), 50)}`,
  Notification:       (h) => `hook note  "${trunc(String(h.message ?? ""), 60)}"`,
  UserPromptSubmit:   (h) => `hook prompt  "${trunc(String(h.prompt ?? ""), 60)}"`,
  PermissionRequest:  (h) => `hook perm  ${h.tool_name ?? h.tool ?? "?"}  → ${h.status ?? h.decision ?? "?"}`,
  Stop:               (h) => `hook stop  reason=${h.stop_reason ?? "?"}`,
  SubagentStart:      (h) => `hook subagent start  id=${h.agent_id ?? "?"}`,
  SubagentStop:       (h) => `hook subagent stop   id=${h.agent_id ?? "?"}`,
  TaskCompleted:      (h) => `hook task completed  id=${h.task_id ?? "?"}`,
};

// ── Printing engine ───────────────────────────────────────────────────────────

function print(line: string) {
  console.log(line);
}

function printBlock(b: any, role: "assistant" | "user") {
  const fmt = BLOCK_FMT[b.type];
  print(fmt ? (fmt(b) ?? "") : `[${role}/${b.type}]`);
}

function printMessage(msg: unknown) {
  const m = msg as any;

  // result is rendered separately in runQuery
  if ("result" in m) return;

  if (m.type === "system") {
    const fmt = SYSTEM_FMT[m.subtype];
    print(fmt ? (fmt(m) ?? "") : `system/${m.subtype}`);
    return;
  }

  if (m.type === "assistant" || m.type === "user") {
    const content: any[] = m.message?.content ?? [];
    if (!content.length) { print(`[${m.type} — empty]`); return; }
    for (const b of content) printBlock(b, m.type);
    return;
  }

  print(`MSG   ${m.type}`);
}

function printHook(event: string, input: unknown) {
  const fmt = HOOK_FMT[event];
  print(fmt ? (fmt(input) ?? "") : `hook  ${event}`);
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
const PERMISSION_MODE = BYPASS ? "bypassPermissions" : "acceptEdits";

// ── REPL ──────────────────────────────────────────────────────────────────────

async function runQuery(prompt: string, sessionId: string | undefined) {
  print(`\n> ${trunc(prompt, W - 2)}`);

  logFull("QUERY", { prompt, sessionId });

  let capturedSessionId = sessionId;

  for await (const message of query({
    prompt,
    options: {
      cwd: process.cwd(),
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

    if ("result" in m) {
      print(`\nresult  stop=${m.stop_reason ?? "?"}`);
    }
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

    function processTyped(data: string) {
      data = data.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ""); // strip CSI sequences
      data = data.replace(/\x1b./gs, "");                 // strip other escapes

      for (const ch of data) {
        const code = ch.charCodeAt(0);
        if (ch === "\r" || ch === "\n")            { submit(buffer); return; }
        else if (ch === "\x7f" || ch === "\x08")   { // backspace
          if (buffer.length > 0) { buffer = buffer.slice(0, -1); process.stdout.write("\b \b"); }
        }
        else if (ch === "\x03") { process.stdout.write("^C"); exit(); } // Ctrl+C
        else if (ch === "\x04") { if (!buffer) exit(); }                // Ctrl+D on empty
        else if (code >= 32)    { buffer += ch; process.stdout.write(ch); }
      }
    }

    function normalizePaste(s: string) {
      return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    }

    function echoPaste(s: string) {
      // \n → \r\n for raw mode; indent continuation lines
      process.stdout.write(s.split("\n").join("\r\n... "));
    }

    function onData(chunk: string) {
      if (inPaste) {
        const end = chunk.indexOf("\x1b[201~");
        if (end !== -1) {
          pasteBuffer += chunk.slice(0, end);
          inPaste = false;
          const normalized = normalizePaste(pasteBuffer);
          pasteBuffer = "";
          echoPaste(normalized);
          submit(buffer + normalized);
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
          const normalized = normalizePaste(rest.slice(0, end));
          echoPaste(normalized);
          submit(buffer + normalized);
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
  print(`  Permissions: ${PERMISSION_MODE}. Full details logged to ${LOG_FILE}.`);
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
      console.error("\nERROR:", err);
      logFull("ERROR", err instanceof Error ? { message: err.message, stack: err.stack } : err);
    }
  }
}

main();
