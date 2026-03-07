import readline from "readline";
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
          .filter((x: any) => x?.type === "text")
          .map((x: any) => x.text)
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
  print(`\n${hr("═")}`);
  print(`  > ${trunc(prompt, W - 4)}`);
  if (sessionId) print(`  session: ${sessionId}`);
  print(hr("═"));

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
      print(`\n${hr("═")}  RESULT  stop=${(m as any).stop_reason ?? "?"}`);
      print(String(m.result ?? ""));
      print(hr("═"));
    }
  }

  return capturedSessionId;
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (q: string) =>
    new Promise<string>((resolve) => rl.question(q, resolve));

  let sessionId: string | undefined;

  print(hr("═"));
  print("  Claude Agent SDK REPL");
  print(`  Permissions: ${PERMISSION_MODE}. Full details logged to ${LOG_FILE}.`);
  print(`  Type 'exit' to quit, 'reset' to start a new session.`);
  print(hr("═"));

  while (true) {
    const input = (await ask("\n> ")).trim();

    if (!input) continue;
    if (input === "exit") break;

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

  rl.close();
}

main();
