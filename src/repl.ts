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

// ── Console summary helpers ───────────────────────────────────────────────────

const W = 70;
const hr = (ch = "─") => ch.repeat(W);

function trunc(s: string, n = 80) {
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function print(line: string) {
  console.log(line);
}

// ── Message printer ───────────────────────────────────────────────────────────

function printBlock(b: any, role: "assistant" | "user") {
  if (b.type === "thinking") {
    print(`\n[thinking]`);
    print(String(b.thinking ?? ""));
    print(`[/thinking]\n`);
  } else if (b.type === "text") {
    print(String(b.text ?? ""));
  } else if (b.type === "tool_use") {
    // assistant requesting a tool call
    const args = Object.entries(b.input ?? {})
      .map(([k, v]) => `${k}=${trunc(String(v), 50)}`)
      .join(", ");
    print(`>> ${b.name}(${args})`);
  } else if (b.type === "tool_result") {
    // user returning a tool result
    const raw = b.content;
    const text = typeof raw === "string"
      ? raw
      : (Array.isArray(raw) ? raw : [raw])
          .map((x: any) => {
            if (x?.type === "text") return x.text;
            if (x?.type === "tool_reference") return `[tool:${x.tool_name}]`;
            return `[${x?.type ?? "?"}]`;
          })
          .join(" ");
    print(b.is_error ? `!! ${trunc(text, 100)}` : `<< ${trunc(text, 100)}`);
  } else {
    print(`[${role}/${b.type}]`);
  }
}

function printMessage(msg: unknown) {
  const m = msg as Record<string, unknown>;
  const type = m.type as string;

  // result is rendered by runQuery; skip here to avoid duplication
  if ("result" in m) return;

  if (type === "system") {
    const sub = (m as any).subtype as string;
    if (sub === "init")              print(`session  ${(m as any).session_id}`);
    else if (sub === "task_started") print(`task started  id=${(m as any).task_id}`);
    else if (sub === "task_progress") {
      const p = m as any;
      print(`task progress  turns=${p.turns ?? "?"} tools=${p.tool_use_count ?? "?"}`);
    }
    else if (sub === "task_notification") print(`task  ${trunc(String((m as any).message ?? ""), 70)}`);
    else                             print(`system/${sub}`);
    return;
  }

  if (type === "assistant") {
    const content = ((m.message as any)?.content ?? []) as any[];
    if (content.length === 0) { print(`[assistant — empty]`); return; }
    for (const b of content) printBlock(b, "assistant");
    return;
  }

  if (type === "user") {
    const content = ((m.message as any)?.content ?? []) as any[];
    if (content.length === 0) { print(`[user — empty]`); return; }
    for (const b of content) printBlock(b, "user");
    return;
  }

  print(`MSG   ${type}`);
}

// ── Hook summarizer ───────────────────────────────────────────────────────────

function summarizeHook(event: string, input: unknown): string {
  const h = input as Record<string, unknown>;

  switch (event) {
    case "PreToolUse": {
      const name = h.tool_name as string;
      const args = Object.entries((h.tool_input as Record<string, unknown>) ?? {})
        .map(([k, v]) => `${k}=${trunc(String(v), 30)}`)
        .join(", ");
      return `HOOK  PreToolUse        ${name}(${args})`;
    }
    case "PostToolUse": {
      const name = h.tool_name as string;
      const ok = (h as any).tool_error == null ? "ok" : "error";
      return `HOOK  PostToolUse       ${name}  (${ok})`;
    }
    case "PostToolUseFailure": {
      const name = h.tool_name as string;
      return `HOOK  PostToolUseFailure  ${name}  ${trunc(String((h as any).tool_error ?? ""), 50)}`;
    }
    case "Notification":
      return `HOOK  Notification      "${trunc(String(h.message ?? ""), 60)}"`;
    case "UserPromptSubmit":
      return `HOOK  UserPromptSubmit  "${trunc(String(h.prompt ?? ""), 60)}"`;
    case "PermissionRequest": {
      const name = (h as any).tool_name ?? (h as any).tool ?? "?";
      const decision = (h as any).status ?? (h as any).decision ?? "?";
      return `HOOK  PermissionRequest  ${name}  → ${decision}`;
    }
    case "Stop":
      return `HOOK  Stop              reason=${(h as any).stop_reason ?? "?"}`;
    case "SubagentStart":
      return `HOOK  SubagentStart     id=${(h as any).agent_id ?? "?"}`;
    case "SubagentStop":
      return `HOOK  SubagentStop      id=${(h as any).agent_id ?? "?"}`;
    case "TaskCompleted":
      return `HOOK  TaskCompleted     id=${(h as any).task_id ?? "?"}`;
    default:
      return `HOOK  ${event}`;
  }
}

// ── Hook factory ──────────────────────────────────────────────────────────────

function makeHook(event: string): HookCallback {
  return async (input) => {
    logFull(`HOOK ${event}`, input);
    print(summarizeHook(event, input));
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

    const m = message as Record<string, unknown>;

    if (m.type === "system" && (m as any).subtype === "init" && !capturedSessionId) {
      capturedSessionId = (m as any).session_id;
    }

    printMessage(message);

    if ("result" in m) {
      print(`\nresult  stop=${(m as any).stop_reason ?? "?"}`);
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
      process.stdout.write("\x1b[?2004l\r\n"); // disable bracketed paste
      process.exit(0);
    }

    function processTyped(data: string) {
      // Strip CSI escape sequences (arrow keys, function keys, etc.)
      data = data.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
      data = data.replace(/\x1b./gs, "");

      for (const ch of data) {
        const code = ch.charCodeAt(0);
        if (ch === "\r" || ch === "\n") { submit(buffer); return; }
        else if (ch === "\x7f" || ch === "\x08") { // backspace
          if (buffer.length > 0) { buffer = buffer.slice(0, -1); process.stdout.write("\b \b"); }
        }
        else if (ch === "\x03") { process.stdout.write("^C"); exit(); } // Ctrl+C
        else if (ch === "\x04") { if (!buffer) exit(); }               // Ctrl+D on empty line
        else if (code >= 32) { buffer += ch; process.stdout.write(ch); }
      }
    }

    function echoPaste(pasted: string) {
      // In raw mode \n doesn't CR; use \r\n and indent continuation lines
      process.stdout.write(pasted.replace(/\n/g, "\r\n... "));
    }

    function onData(chunk: string) {
      // If we're mid-paste, accumulate until the closing marker
      if (inPaste) {
        const end = chunk.indexOf("\x1b[201~");
        if (end !== -1) {
          pasteBuffer += chunk.slice(0, end);
          inPaste = false;
          const pasted = pasteBuffer;
          pasteBuffer = "";
          echoPaste(pasted);
          submit(buffer + pasted);
        } else {
          pasteBuffer += chunk;
        }
        return;
      }

      // Check for paste start marker
      const start = chunk.indexOf("\x1b[200~");
      if (start !== -1) {
        processTyped(chunk.slice(0, start)); // handle anything typed before the paste
        const rest = chunk.slice(start + 6); // skip \x1b[200~
        const end = rest.indexOf("\x1b[201~");
        if (end !== -1) {
          // Entire paste arrived in one chunk
          const pasted = rest.slice(0, end);
          echoPaste(pasted);
          submit(buffer + pasted);
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
