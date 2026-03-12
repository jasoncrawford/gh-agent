# brunel

A GitHub webhook listener that will evolve into a Claude Code agent. It receives GitHub events and prints structured summaries. Eventually it will invoke the Claude Agent SDK in response to events.

## Dev workflow

Two terminals:

```
# terminal 1 — proxy GitHub webhooks to localhost
npx smee-client --url https://smee.io/YOUR_CHANNEL --target http://localhost:3000/webhook

# terminal 2 — run the server
npm start
```

## Git workflow

- Always create a feature branch and PR for changes — never commit directly to `main`.
- Do NOT auto-merge PRs — leave merging to the user after UAT.

## Key conventions

- TypeScript with ESM (`"type": "module"`). New dependencies must be ESM-compatible.
- No compilation step — `tsx` runs TypeScript directly.
- Webhook secret is optional for local dev; set `WEBHOOK_SECRET` in `.env` to enable signature verification.
