# GitHub Agent: Design Document

## Goal

Build a Claude-based agent that listens to GitHub notifications on a given project, works on issues, creates PRs, and shepherds them to completion. The agent uses a configurable set of skills (marketplace plugins and custom/private skills).

## Architecture Options (Ranked)

### Option A: GitHub Actions with claude-code-action (Simplest start)

The official `anthropics/claude-code-action@v1` GitHub Action handles most triggers out of the box. No infrastructure to manage.

**What works today:**
- New issue (optionally filtered by label) triggers agent to implement and create a PR
- CI failure on a PR triggers agent to analyze logs and push a fix
- PR review comments trigger agent to address feedback
- `@claude` mentions in any issue/PR comment trigger a response
- Agent leaves comments on PRs explaining its changes

**Workflow skeleton:**

```yaml
name: GitHub Agent
on:
  issues:
    types: [opened, labeled]
  issue_comment:
    types: [created]
  pull_request_review:
    types: [submitted]
  pull_request_review_comment:
    types: [created]
  check_run:
    types: [completed]

jobs:
  agent:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: anthropics/claude-code-action@v1
        with:
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          # prompt varies by trigger — see conditional logic below
```

**Key limitation:** Each invocation is stateless. No memory of prior interactions on the same PR. Mitigation: rich `CLAUDE.md` in the repo provides persistent project context.

**Does not handle (needs custom work):**
- Auto-rebasing stale branches (use a scheduled workflow)
- Merge conflict detection (GitHub doesn't fire events for this)
- Complex decision trees across multiple interactions

**Examples and templates:** https://github.com/anthropics/claude-code-action/tree/main/examples

### Option B: Custom Agent SDK Server (Maximum control)

A self-hosted webhook server using the Claude Agent SDK (Python or TypeScript). Listens for GitHub webhook events and dispatches agent sessions.

**Advantages over GitHub Actions:**
- Maintains session context across multiple events on the same PR (via `resume` with session IDs)
- Can fork sessions to try alternative approaches
- Full hook system for intercepting and modifying agent behavior
- Can inject context mid-session (system messages via hooks)
- Streaming transcript access for posting progress updates

**Architecture:**

```
GitHub Webhook → Your Server → Claude Agent SDK
                                    ↓
                    Session store (PR ID → session ID)
                                    ↓
                        GitHub API (commits, comments, PRs)
```

**Minimal server sketch (Python):**

```python
import subprocess
from claude_agent_sdk import query, ClaudeAgentOptions

sessions = {}  # Persist to a database in production

async def handle_webhook(event_type, payload):
    pr_id = payload.get("pull_request", {}).get("id") or payload.get("issue", {}).get("id")
    session_id = sessions.get(pr_id)

    # Inject git context
    branch = subprocess.check_output(["git", "branch", "--show-current"]).decode().strip()
    status = subprocess.check_output(["git", "status", "--short"]).decode().strip()

    prompt = build_prompt(event_type, payload, branch, status)

    options = ClaudeAgentOptions(
        cwd="/path/to/checked-out/repo",
        setting_sources=["project"],        # Loads skills from .claude/skills/
        allowed_tools=["Skill", "Read", "Write", "Edit", "Bash", "Glob", "Grep"],
        resume=session_id,                  # Resume prior context if exists
    )

    async for message in query(prompt=prompt, options=options):
        if hasattr(message, "session_id"):
            sessions[pr_id] = message.session_id
        # Stream to logs, post updates to GitHub, etc.
```

**What you'd build:**
- Webhook listener (Flask/FastAPI/Express)
- GitHub webhook signature verification
- Event router (issue opened → implement; check failed → fix; review → address)
- Session store (PR/issue ID → agent session ID)
- Git checkout management (each PR needs a working copy)
- GitHub API integration for posting comments, creating PRs, pushing commits

### Option C: Claude Hub (Open-source middle ground)

[claude-did-this/claude-hub](https://github.com/claude-did-this/claude-hub) is an open-source webhook server that sits between GitHub and Claude Code. Maintains session context across triggers. Runs as a Docker container with Cloudflare tunnel. Worth evaluating before building Option B from scratch.

## Skills

### How skills work with the Agent SDK

The SDK supports skill discovery and auto-loading when configured:

```python
options = ClaudeAgentOptions(
    cwd="/path/to/project",
    setting_sources=["project"],   # Required — without this, no skills
    allowed_tools=["Skill", ...],  # Must include "Skill"
)
```

With this set, the SDK:
1. Scans `.claude/skills/` in the project directory
2. Reads YAML frontmatter (name, description) from each `SKILL.md`
3. Injects skill descriptions into the system prompt
4. Loads full skill content on-demand when Claude decides to invoke one

### Skill format

```
.claude/
  skills/
    review-code/
      SKILL.md          # Required: frontmatter + instructions
    implement-issue/
      SKILL.md
    fix-ci/
      SKILL.md
```

Each `SKILL.md`:

```markdown
---
name: review-code
description: Use when reviewing code changes for quality, security, and correctness
allowed-tools:
  - Read
  - Grep
  - Glob
---

## Instructions for reviewing code

[Full skill content loaded on-demand when invoked]
```

### Skill sources and portability

| Source | Works in CLI | Works in GH Actions | Works in SDK |
|--------|-------------|-------------------|-------------|
| `.claude/skills/` in repo | Yes | Yes | Yes (with `setting_sources`) |
| `~/.claude/skills/` personal | Yes | No (ephemeral runners) | Depends on host |
| claude.ai account (marketplace) | Unclear | No (API key auth) | No |

**Recommendation:** Commit all skills to `.claude/skills/` in the repo. This is the only source that works reliably across all execution contexts.

To use marketplace skills in CI/headless contexts: find the skill's source (many are on GitHub), download it into `.claude/skills/`, and commit it.

## Git Awareness

The Agent SDK has no built-in git awareness. Claude Code injects branch/status/history into context at startup; the SDK does not.

**Replicating it is trivial** — inject git state into the prompt:

```python
import subprocess

def git_context(repo_path):
    def run(cmd):
        return subprocess.check_output(cmd, cwd=repo_path).decode().strip()
    return {
        "branch": run(["git", "branch", "--show-current"]),
        "status": run(["git", "status", "--short"]),
        "recent_commits": run(["git", "log", "--oneline", "-10"]),
    }
```

Beyond that, Claude naturally runs git commands via Bash as needed (commit, push, rebase, diff).

## Conversation Visibility

The Agent SDK streams typed message objects:

- `AssistantMessage` with content blocks: `TextBlock`, `ToolUseBlock`, `ToolResultBlock`, `ThinkingBlock`
- `ResultMessage` at the end with `session_id`, `total_cost_usd`, `num_turns`
- `StreamEvent` (raw API events if `include_partial_messages=True`)

You can log every tool call, every result, and the full chain of thought (if extended thinking is enabled). This is useful for posting progress updates to GitHub PR comments.

### Injecting context mid-session

| Mechanism | How |
|-----------|-----|
| System message injection | Return `{"systemMessage": "..."}` from a hook |
| Modify tool inputs | `PreToolUse` hook with `updatedInput` |
| Modify user prompt | `UserPromptSubmit` hook |
| Arbitrary human message | Not supported — wait for session to finish, then `resume` with new prompt |

## Context and Compaction

**Important limitation:** The Agent SDK does not handle context window compaction. Long sessions that accumulate many tool calls and results will eventually hit context limits.

Mitigations:
- Set `max_turns` to bound session length
- Use subagents for isolated subtasks (they get fresh context)
- For multi-event workflows, summarize prior work in the `resume` prompt rather than relying on full history
- Keep `CLAUDE.md` concise and relevant

## Cost Considerations

- Each agent invocation costs API tokens
- Large repos consume more tokens (file reads, grep results)
- Frequent triggers (every PR comment, every CI run) multiply costs
- Use `max_turns` and model selection to control spend
- The SDK returns `total_cost_usd` in `ResultMessage` — log this
- Consider using Sonnet for routine tasks (review, CI fixes) and Opus for complex implementation

## Authentication

All approaches support:
- **Anthropic API key**: `ANTHROPIC_API_KEY`
- **AWS Bedrock**: `CLAUDE_CODE_USE_BEDROCK=1` + AWS credentials
- **Google Vertex AI**: `CLAUDE_CODE_USE_VERTEX=1` + GCP credentials
- **Azure Foundry**: `CLAUDE_CODE_USE_FOUNDRY=1` + Azure credentials

## Slack Integration

Claude Code has a Slack app that can kick off web coding sessions from Slack messages. This is a separate system from the Agent SDK — it runs sessions on claude.ai/code, not your infrastructure.

For a custom bot that posts to Slack: use the Slack API directly from your webhook server. Post agent progress, link to PRs, receive commands via Slack messages routed to your webhook handler.

## Suggested Starting Point

1. **Start with GitHub Actions** (Option A). Create a single workflow file with multi-trigger support. Use a label like `agent` to control which issues the agent picks up. Get the basic loop working: issue → PR → CI fix → review response.

2. **Add skills** to `.claude/skills/` for your project's conventions, review standards, and implementation patterns.

3. **Evaluate whether statelessness is a problem.** If the agent handles most interactions well without memory of prior turns, stay with Actions. If context loss causes repeated mistakes, move to Option B or C.

4. **Graduate to the Agent SDK** when you need session persistence, custom orchestration logic, or tighter integration with other systems.

## Key Links

- claude-code-action: https://github.com/anthropics/claude-code-action
- claude-code-action examples: https://github.com/anthropics/claude-code-action/tree/main/examples
- Agent SDK docs: https://platform.claude.com/docs/en/agent-sdk/overview
- Agent SDK hooks: https://platform.claude.com/docs/en/agent-sdk/hooks
- Agent SDK skills: https://platform.claude.com/docs/en/agent-sdk/skills
- Claude Hub: https://github.com/claude-did-this/claude-hub
- Claude Code skills docs: https://code.claude.com/docs/en/skills
- GitHub Actions events: https://docs.github.com/actions/learn-github-actions/events-that-trigger-workflows
