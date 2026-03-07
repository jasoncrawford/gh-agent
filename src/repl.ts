import readline from "readline";
import { query, type HookCallback } from "@anthropic-ai/claude-agent-sdk";

// ── Formatting helpers ────────────────────────────────────────────────────────

const W = 70;
const hr = (ch = "─") => ch.repeat(W);

function box(title: string, content?: unknown) {
  console.log("\n" + hr("═"));
  console.log(`  ${title}`);
  if (content !== undefined) {
    console.log(hr());
    console.log(JSON.stringify(content, null, 2));
  }
  console.log(hr("═"));
}

function section(title: string, content?: unknown) {
  console.log("\n" + hr());
  console.log(`  ${title}`);
  if (content !== undefined) {
    console.log(hr());
    console.log(JSON.stringify(content, null, 2));
  }
}

// ── Hook factory ─────────────────────────────────────────────────────────────

function makeHook(event: string): HookCallback {
  return async (input) => {
    section(`HOOK  ${event}`, input);
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

// ── REPL ─────────────────────────────────────────────────────────────────────

async function runQuery(prompt: string, sessionId: string | undefined) {
  box(`QUERY${sessionId ? `  (resuming ${sessionId})` : ""}`);
  console.log(prompt);

  let capturedSessionId = sessionId;
  let turnCount = 0;

  for await (const message of query({
    prompt,
    options: {
      cwd: process.cwd(),
      permissionMode: "dontAsk",
      ...(sessionId ? { resume: sessionId } : {}),
      hooks,
    },
  })) {
    turnCount++;

    // Capture session ID from the init message
    if (
      message.type === "system" &&
      (message as any).subtype === "init" &&
      !capturedSessionId
    ) {
      capturedSessionId = (message as any).session_id;
    }

    // Log every message
    section(`MESSAGE #${turnCount}  type=${message.type}`, message);

    // Print the final result prominently
    if ("result" in message) {
      box("RESULT");
      console.log(message.result);
      console.log(`\nstop_reason: ${(message as any).stop_reason ?? "unknown"}`);
    }
  }

  return capturedSessionId;
}

async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = (q: string) =>
    new Promise<string>((resolve) => rl.question(q, resolve));

  let sessionId: string | undefined;

  console.log(hr("═"));
  console.log("  Claude Agent SDK REPL");
  console.log("  All messages and hooks are logged. Type 'exit' to quit.");
  console.log("  Type 'reset' to start a new session.");
  console.log(hr("═"));

  while (true) {
    const input = (await prompt("\n> ")).trim();

    if (!input) continue;
    if (input === "exit") break;

    if (input === "reset") {
      sessionId = undefined;
      console.log("Session reset.");
      continue;
    }

    try {
      sessionId = await runQuery(input, sessionId);
    } catch (err) {
      console.error("\nERROR:", err);
    }
  }

  rl.close();
}

main();
