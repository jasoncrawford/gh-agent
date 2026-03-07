import { Webhooks } from "@octokit/webhooks";
import http from "http";
import "dotenv/config";

const PORT = parseInt(process.env.PORT ?? "3000");
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

// ── Webhook handler ───────────────────────────────────────────────────────────

const webhooks = WEBHOOK_SECRET ? new Webhooks({ secret: WEBHOOK_SECRET }) : null;

if (webhooks) {
  webhooks.onAny(({ id, name, payload }) => printEvent(id, name as string, payload));
}

function printEvent(id: string, name: string, payload: unknown) {
  const p = payload as Record<string, unknown>;
  const action = typeof p.action === "string" ? ` / ${p.action}` : "";

  console.log(`\n${"═".repeat(70)}`);
  console.log(`EVENT   ${name}${action}`);
  console.log(`ID      ${id}`);
  console.log("─".repeat(70));

  const repo = p.repository as R | undefined;
  const sender = p.sender as R | undefined;
  if (repo) console.log(`REPO    ${repo.full_name}`);
  if (sender) console.log(`BY      ${sender.login}`);

  details(name, p);
  console.log("═".repeat(70));
}

type R = Record<string, unknown>;

function field(label: string, value: unknown) {
  if (value == null || value === "" || value === false) return;
  console.log(`${label.padEnd(8)}${value}`);
}

function body(label: string, text: unknown) {
  const s = String(text ?? "").trim();
  if (!s) return;
  console.log(`\n${label}:\n${s}`);
}

function logins(items: R[] | undefined) {
  return items?.map((i) => i.login).join(", ") ?? "";
}

function labels(items: { name: string }[] | undefined) {
  return items?.map((l) => l.name).join(", ") ?? "";
}

function details(name: string, p: R) {
  const issue = p.issue as R | undefined;
  const pr = p.pull_request as R | undefined;
  const comment = p.comment as R | undefined;
  const review = p.review as R | undefined;

  switch (name) {
    case "issues": {
      if (!issue) break;
      field("ISSUE", `#${issue.number}: ${issue.title}`);
      field("STATE", issue.state);
      field("LABELS", labels(issue.labels as { name: string }[]));
      field("ASSIGN", logins(issue.assignees as R[]));
      body("BODY", issue.body);
      if (p.action === "labeled" || p.action === "unlabeled") {
        field("LABEL", (p.label as R)?.name);
      }
      break;
    }

    case "issue_comment": {
      if (!issue || !comment) break;
      field("ISSUE", `#${issue.number}: ${issue.title}`);
      field("STATE", issue.state);
      field("LABELS", labels(issue.labels as { name: string }[]));
      body("COMMENT", comment.body);
      break;
    }

    case "pull_request": {
      if (!pr) break;
      const head = pr.head as R;
      const base = pr.base as R;
      field("PR", `#${pr.number}: ${pr.title}`);
      field("BRANCH", `${head.ref} → ${base.ref}`);
      field("STATE", `${pr.state}${pr.draft ? " (draft)" : ""}${pr.merged ? " (merged)" : ""}`);
      field("LABELS", labels(pr.labels as { name: string }[]));
      field("ASSIGN", logins(pr.assignees as R[]));
      field("REVIEW", logins(pr.requested_reviewers as R[]));
      body("BODY", pr.body);
      break;
    }

    case "pull_request_review": {
      if (!pr || !review) break;
      field("PR", `#${pr.number}: ${pr.title}`);
      field("STATE", review.state);
      body("REVIEW", review.body);
      break;
    }

    case "pull_request_review_comment": {
      if (!pr || !comment) break;
      field("PR", `#${pr.number}: ${pr.title}`);
      field("FILE", `${comment.path} (line ${comment.original_line ?? comment.line ?? "?"})`);
      body("DIFF", comment.diff_hunk);
      body("COMMENT", comment.body);
      break;
    }

    case "push": {
      const commits = p.commits as R[] | undefined;
      field("REF", p.ref);
      field("COMMITS", commits?.length ?? 0);
      commits?.forEach((c) => {
        const author = (c.author as R)?.name ?? "?";
        const sha = String(c.id).slice(0, 7);
        console.log(`  ${sha}  ${c.message}  (${author})`);
      });
      break;
    }

    case "check_run": {
      const run = p.check_run as R;
      const output = run.output as R | undefined;
      field("CHECK", run.name);
      field("STATUS", `${run.status} / ${run.conclusion ?? "pending"}`);
      if (output?.title) body("OUTPUT", `${output.title}\n${output.summary ?? ""}`);
      break;
    }

    case "workflow_run": {
      const run = p.workflow_run as R;
      field("WORKFLOW", run.name);
      field("BRANCH", run.head_branch);
      field("STATUS", `${run.status} / ${run.conclusion ?? "pending"}`);
      break;
    }

    case "create":
    case "delete":
      field("REF", `${p.ref} (${p.ref_type})`);
      break;

    case "release": {
      const release = p.release as R;
      field("RELEASE", `${release.tag_name}: ${release.name}`);
      body("BODY", release.body);
      break;
    }
  }
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/webhook") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    const body = Buffer.concat(chunks).toString();

    const id = (req.headers["x-github-delivery"] as string) ?? "unknown";
    const name = req.headers["x-github-event"] as string;
    const signature = req.headers["x-hub-signature-256"] as string;

    if (!name) {
      res.writeHead(400);
      res.end("Missing x-github-event header");
      return;
    }

    try {
      if (webhooks && signature) {
        await webhooks.verifyAndReceive({
          id,
          name: name as Parameters<typeof webhooks.verifyAndReceive>[0]["name"],
          signature,
          payload: body,
        });
      } else {
        printEvent(id, name, JSON.parse(body));
      }
      res.writeHead(200);
      res.end("OK");
    } catch (err) {
      console.error("Webhook processing error:", err);
      res.writeHead(400);
      res.end("Bad Request");
    }
    return;
  }

  if (req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("GitHub webhook listener running. POST events to /webhook");
    return;
  }

  res.writeHead(404);
  res.end("Not Found");
});

server.listen(PORT, () => {
  console.log(`\nListening on http://localhost:${PORT}/webhook`);
  console.log("Waiting for events...\n");
});
