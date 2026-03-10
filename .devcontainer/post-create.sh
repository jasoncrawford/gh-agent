#!/bin/bash
set -euo pipefail

# Seed .claude.json from host on first create, if source exists and destination doesn't.
# This supplies hasCompletedOnboarding and account info (auth tokens come from CLAUDE_CODE_OAUTH_TOKEN).
if [ -f /home/node/.claude-host/.claude.json ] && [ ! -f /home/node/.claude/.claude.json ]; then
    cp /home/node/.claude-host/.claude.json /home/node/.claude/.claude.json
fi

# Remove empty plugins dir if present so the plugin installer can recreate it cleanly.
# Fails silently if the dir doesn't exist or is non-empty (already installed) — both are fine.
rmdir /home/node/.claude/plugins 2>/dev/null || true

# Install superpowers plugin.
# Note: runs before the firewall is set up (postStartCommand) — this is intentional.
claude plugin marketplace add obra/superpowers-marketplace
claude plugin install superpowers@superpowers-marketplace
