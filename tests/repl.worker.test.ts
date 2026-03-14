import { describe, it, expect } from "vitest";
import { buildWorkerWsUrl } from "../src/repl.js";

describe("buildWorkerWsUrl", () => {
  it("appends /worker path to foreman base URL", () => {
    expect(buildWorkerWsUrl("ws://localhost:3000")).toBe("ws://localhost:3000/worker");
  });

  it("works with custom foreman URL", () => {
    expect(buildWorkerWsUrl("ws://myserver:8080")).toBe("ws://myserver:8080/worker");
  });
});
