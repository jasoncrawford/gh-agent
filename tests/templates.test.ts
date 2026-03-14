import { describe, it, expect } from "vitest";
import { buildInitialPrompt, buildEventPrompt } from "../src/templates.js";
import type { GitHubEvent } from "../src/types.js";

describe("buildInitialPrompt", () => {
  it("includes issue number, title, and body", () => {
    const p = buildInitialPrompt({ number: 42, title: "Fix bug", body: "It crashes", labels: ["bug"], repoUrl: "https://github.com/x/y" });
    expect(p).toContain("#42");
    expect(p).toContain("Fix bug");
    expect(p).toContain("It crashes");
  });

  it("handles empty body gracefully", () => {
    const p = buildInitialPrompt({ number: 1, title: "T", body: "", labels: [], repoUrl: "https://github.com/x/y" });
    expect(p).toBeTruthy();
  });
});

describe("buildEventPrompt", () => {
  it("returns multi-event fallback for 2+ events", () => {
    const events: GitHubEvent[] = [
      { id: "e1", name: "check_run", payload: {} },
      { id: "e2", name: "pull_request_review", payload: {} },
    ];
    const p = buildEventPrompt(events);
    expect(p).toContain("Multiple events");
  });

  it("uses check_run template for single CI failure", () => {
    const evt: GitHubEvent = {
      id: "e1", name: "check_run",
      payload: { check_run: { name: "test", conclusion: "failure", output: { summary: "5 tests failed" } } },
    };
    const p = buildEventPrompt([evt]);
    expect(p).toContain("test");
    expect(p).toContain("failure");
    expect(p).toContain("5 tests failed");
  });

  it("uses review template for pull_request_review", () => {
    const evt: GitHubEvent = {
      id: "e1", name: "pull_request_review",
      payload: { pull_request: { number: 5 }, review: { state: "changes_requested", body: "Please fix X" } },
    };
    const p = buildEventPrompt([evt]);
    expect(p).toContain("PR #5");
    expect(p).toContain("Please fix X");
  });

  it("falls back gracefully for unknown event type", () => {
    const evt: GitHubEvent = { id: "e1", name: "deployment", payload: {} };
    expect(() => buildEventPrompt([evt])).not.toThrow();
  });
});
