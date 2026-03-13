# Foreman/Worker Architecture Design

**Date:** 2026-03-13
**Status:** Approved

## Overview

Brunel evolves from a webhook printer into an autonomous agent system. A **foreman** process manages a queue of GitHub issues and coordinates a fleet of **workers**, each running a Claude agent session that works a task to completion. The user experience: label a GitHub issue `brunel:ready` and it gets done.

## Architecture

Two processes communicate over WebSocket.

```
GitHub ──webhook──▶ Foreman (src/foreman.ts)
                        │  WebSocket (/worker)
                    ┌───┴───┐
                 Worker   Worker   ...
               (repl --worker-mode)
```

**Foreman** — evolves from `src/index.ts`:
- Receives GitHub webhooks (existing behavior retained)
- On startup, scans GitHub API for open issues labeled `brunel:ready` → seeds pending task queue
- Accepts WebSocket connections from workers on the `/worker` path of the existing HTTP server
- Assigns pending tasks to idle workers
- Routes incoming webhook events to the worker handling the relevant issue/PR
- Tracks all state in memory; re-scans GitHub on restart as crash recovery

**Worker** — new mode of `src/repl.ts` (`--worker-mode`):
- Connects to foreman via WebSocket on startup
- Receives typed structured messages (task assignments, event notifications)
- Generates agent prompts from those messages using local templates
- Runs the agent loop (`runQuery()`) until the agent stops naturally
- After each loop: signals foreman it's idle; receives queued events or waits
- Accepts `/task-complete` slash command to release the task and return to idle

Workers run in Docker devcontainers (one per worker). Foreman runs separately. All on one machine initially; designed to move to cloud without protocol changes. In cloud deployments, use `wss://` for `FOREMAN_URL` and configure TLS accordingly.

**Docker networking:** When running locally with Docker devcontainers, workers must be able to reach the foreman. Configure via Docker Compose service names, host networking, or an explicit `FOREMAN_URL` pointing to the host IP. This is a deployment concern, not handled by the protocol itself.

## WebSocket Protocol

All messages are JSON. The same `worker_hello` message is used for both initial connection and reconnection.

### Worker → Foreman

| Message | Fields | When |
|---------|--------|------|
| `worker_hello` | `workerId`, `taskId?`, `status: "idle"\|"busy"` | On connect or reconnect |
| `agent_idle` | `workerId`, `taskId` | Agent loop finished, ready for next prompt |
| `task_complete` | `workerId`, `taskId` | User ran `/task-complete` |

### Foreman → Worker

| Message | Fields | When |
|---------|--------|------|
| `task_assigned` | `taskId`, `issue: { number, title, body, labels, repoUrl }` | Task available for worker |
| `event_notification` | `taskId`, `events: GitHubEvent[]` | One or more queued events for active task |
| `standby` | — | No tasks available; worker waits |

The foreman **always** responds to `worker_hello` with either `task_assigned` or `standby`. Workers can rely on this to know they are registered.

The foreman **always** responds to `agent_idle` with either `event_notification` or `standby`. Workers can rely on this to know their idle signal was received.

The foreman **silently ignores** messages referencing unknown `taskId`s (e.g., a late `agent_idle` for a task already marked complete). No error response.

### `GitHubEvent` type

Defined once in shared code (e.g., `src/types.ts`) and used in both the protocol and foreman state:

```typescript
interface GitHubEvent {
  id: string;           // x-github-delivery header value
  name: string;         // e.g. "check_run", "pull_request_review_comment"
  payload: Record<string, unknown>;  // raw webhook payload
}
```

## Worker Identity and Reconnection

Workers have **stable IDs** — a UUID generated on first startup and persisted to `.worker-id` in the working directory. This survives container restarts and foreman crashes.

On reconnect, the worker sends `worker_hello` with its current state (`taskId`, `status`). The foreman reconciles:
- If `status: "busy"` with a `taskId`: foreman marks that task as assigned to this worker, removing it from the pending queue if present. **First reconnecting claim wins** — if two workers somehow claim the same `taskId`, the second gets `standby`.
- If `status: "idle"`: foreman treats this as a fresh registration and assigns the next pending task or sends `standby`.

**Workers continue working during disconnection.** The WebSocket and the agent loop are independent. If the foreman goes away mid-session, the worker keeps running `runQuery()` and reconnects in the background with exponential backoff. No work is lost.

**`/task-complete` timing:** This slash command is only available between agent loops — the worker's input prompt is only shown after `runQuery()` returns. There is no risk of the user completing a task while the agent is still running.

## Task Lifecycle

1. Issue labeled `brunel:ready` on GitHub → foreman receives webhook (or finds it on startup scan) → task added to pending queue
2. Idle worker sends `worker_hello` or `agent_idle` → foreman sends `task_assigned` or `standby`
3. Worker generates initial prompt from issue data using a local template → calls `runQuery()`
4. Agent works: creates branch, writes code, opens PR
5. GitHub events arrive (CI results, review comments, etc.) → foreman queues them on the `Task` object
6. Agent finishes a loop → worker sends `agent_idle` → foreman sends `event_notification` (draining the task's event queue) or `standby` (if empty)
7. Worker generates a prompt from the events → calls `runQuery()` resuming the same session
8. User types `/task-complete` → worker sends `task_complete` → foreman labels issue `brunel:done`, removes from active tasks → worker goes idle → foreman sends next task or `standby`

## Event Coalescing

When the foreman sends `event_notification`, it drains the entire event queue for that task and sends all accumulated events in one message. The worker turns them into a prompt:

- **Single event**: per-type template (e.g., CI failure → structured summary of the failure)
- **Multiple events**: static fallback: *"Multiple events have arrived since you last checked. Please review the current state of your PR and respond accordingly."*

Templates live in `src/templates.ts`. The coalescing logic is designed to become more sophisticated over time (e.g., latest CI status + latest CodeQL status + all new comments) without changing the protocol.

**Events for pending tasks** (no worker assigned yet): queued on the `Task` object and delivered to the worker when the task is eventually assigned.

## Foreman State

In-memory only. Rebuilt from GitHub on restart.

```typescript
// GitHubEvent defined in src/types.ts — see Protocol section

interface Task {
  taskId: string;       // String(issueNumber) — canonical identifier
  issueNumber: number;
  title: string;
  body: string;
  labels: string[];
  repoUrl: string;
  status: "pending" | "assigned" | "complete";
  assignedWorkerId?: string;
  eventQueue: GitHubEvent[];  // queued even before assignment
}

interface WorkerState {
  workerId: string;
  ws: WebSocket;
  status: "idle" | "busy";
  currentTaskId?: string;
}
```

## Configuration

All via environment variables (`.env`):

| Variable | Purpose | Default |
|----------|---------|---------|
| `GITHUB_REPO` | `owner/repo` to manage | required |
| `GITHUB_TOKEN` | GitHub API access | required |
| `TASK_LABEL` | Label marking issues as ready | `brunel:ready` |
| `DONE_LABEL` | Label applied on completion | `brunel:done` |
| `PORT` | HTTP + WebSocket port | `3000` |
| `FOREMAN_URL` | Worker uses to connect (use `wss://` in production) | `ws://localhost:3000` |

## Code Structure

### Files changed

**`src/foreman.ts`** (renamed from `src/index.ts`):
- `WorkerRegistry` class — connected workers, state
- `TaskQueue` class — pending/assigned tasks, GitHub API seeding
- WebSocket server on `/worker` upgrade path of existing HTTP server
- Event router — on webhook, push to task's event queue; if task is assigned, notify worker immediately

**`src/repl.ts`** — additions:
- `workerMain()` alongside existing `main()` — WebSocket connection, worker loop
- `/task-complete` slash command — new case in `parseSlashCommand()`

**New files:**
- `src/templates.ts` — prompt templates keyed by event type
- `src/worker-id.ts` — reads/writes `.worker-id`

### Refactor first (separate PR)

Before adding worker mode, extract the formatting/printing engine from `src/repl.ts` into a shared module (e.g., `src/display.ts`). This gives `workerMain()` clean access to the printing infrastructure without importing REPL input handling. The refactor is pure behavior-preserving restructuring with no functional changes, making it safe to land as a standalone PR.

### npm scripts

```
npm start          # src/foreman.ts
npm run repl       # src/repl.ts (interactive, as today)
npm run worker     # src/repl.ts --worker-mode
```

## Out of Scope (v1)

- Sophisticated task prioritization or planning in the foreman
- Dynamic worker scaling
- Persistent task state (database)
- Multi-repo support
- Automatic PR merging
- TLS/WSS configuration details
