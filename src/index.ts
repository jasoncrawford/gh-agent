import { Webhooks } from "@octokit/webhooks";
import SmeeClient from "smee-client";
import http from "http";
import "dotenv/config";

const PORT = parseInt(process.env.PORT ?? "3000");
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const SMEE_URL = process.env.SMEE_URL;

// ── Smee proxy ────────────────────────────────────────────────────────────────

if (SMEE_URL) {
  const smee = new SmeeClient({
    source: SMEE_URL,
    target: `http://localhost:${PORT}/webhook`,
    logger: console,
  });
  smee.start();
  console.log(`Smee proxy: ${SMEE_URL} → http://localhost:${PORT}/webhook`);
} else {
  console.log("No SMEE_URL set — POST directly to /webhook");
}

// ── Webhook handler ───────────────────────────────────────────────────────────

const webhooks = WEBHOOK_SECRET ? new Webhooks({ secret: WEBHOOK_SECRET }) : null;

if (webhooks) {
  webhooks.onAny(({ id, name, payload }) => printEvent(id, name as string, payload));
}

function printEvent(id: string, name: string, payload: unknown) {
  const p = payload as Record<string, unknown>;
  const action = typeof p.action === "string" ? ` / ${p.action}` : "";

  const line = "─".repeat(70);
  console.log(`\n${"═".repeat(70)}`);
  console.log(`EVENT   ${name}${action}`);
  console.log(`ID      ${id}`);
  console.log(line);

  const repo = p.repository as Record<string, unknown> | undefined;
  const sender = p.sender as Record<string, unknown> | undefined;
  if (repo) console.log(`REPO    ${repo.full_name}`);
  if (sender) console.log(`BY      ${sender.login}`);

  summarize(name, p);

  console.log(`\nPAYLOAD:\n${JSON.stringify(payload, null, 2)}`);
  console.log("═".repeat(70));
}

function summarize(name: string, p: Record<string, unknown>) {
  const issue = p.issue as Record<string, unknown> | undefined;
  const pr = p.pull_request as Record<string, unknown> | undefined;
  const comment = p.comment as Record<string, unknown> | undefined;
  const review = p.review as Record<string, unknown> | undefined;

  const truncate = (s: string, n = 120) =>
    s.length > n ? s.slice(0, n) + "…" : s;

  switch (name) {
    case "issues":
      if (issue) {
        console.log(`ISSUE   #${issue.number}: ${issue.title}`);
        console.log(`URL     ${issue.html_url}`);
        const labels = (issue.labels as { name: string }[])
          ?.map((l) => l.name)
          .join(", ");
        if (labels) console.log(`LABELS  ${labels}`);
      }
      break;

    case "issue_comment":
      if (issue && comment) {
        console.log(`ISSUE   #${issue.number}: ${issue.title}`);
        console.log(`BODY    ${truncate(String(comment.body ?? ""))}`);
      }
      break;

    case "pull_request":
      if (pr) {
        const head = pr.head as Record<string, unknown>;
        const base = pr.base as Record<string, unknown>;
        console.log(`PR      #${pr.number}: ${pr.title}`);
        console.log(`URL     ${pr.html_url}`);
        console.log(`BRANCH  ${head.ref} → ${base.ref}`);
        console.log(`STATE   ${pr.state} | draft: ${pr.draft} | merged: ${pr.merged}`);
      }
      break;

    case "pull_request_review":
      if (pr && review) {
        console.log(`PR      #${pr.number}: ${pr.title}`);
        console.log(`STATE   ${review.state}`);
        if (review.body) console.log(`BODY    ${truncate(String(review.body))}`);
      }
      break;

    case "pull_request_review_comment":
      if (pr && comment) {
        console.log(`PR      #${pr.number}: ${pr.title}`);
        console.log(`FILE    ${comment.path}`);
        console.log(`BODY    ${truncate(String(comment.body ?? ""))}`);
      }
      break;

    case "push": {
      const commits = p.commits as unknown[] | undefined;
      console.log(`REF     ${p.ref}`);
      console.log(`COMMITS ${commits?.length ?? 0}`);
      const head_commit = p.head_commit as Record<string, unknown> | undefined;
      if (head_commit) console.log(`HEAD    ${head_commit.message}`);
      break;
    }

    case "check_run": {
      const run = p.check_run as Record<string, unknown>;
      console.log(`CHECK   ${run.name}`);
      console.log(`STATUS  ${run.status} | conclusion: ${run.conclusion ?? "—"}`);
      break;
    }

    case "workflow_run": {
      const run = p.workflow_run as Record<string, unknown>;
      console.log(`WORKFLOW  ${run.name}`);
      console.log(`STATUS    ${run.status} | conclusion: ${run.conclusion ?? "—"}`);
      break;
    }

    case "create":
    case "delete":
      console.log(`REF     ${p.ref} (${p.ref_type})`);
      break;

    case "release": {
      const release = p.release as Record<string, unknown>;
      console.log(`RELEASE ${release.tag_name}: ${release.name}`);
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
