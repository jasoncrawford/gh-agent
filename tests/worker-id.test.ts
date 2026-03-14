import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted by Vitest. worker-id.ts has no module-level state —
// getWorkerId() always calls fs on each invocation, so no resetModules() needed.
vi.mock("fs");
import fs from "fs";
import { getWorkerId } from "../src/worker-id.js";

beforeEach(() => {
  vi.mocked(fs.readFileSync).mockReset();
  vi.mocked(fs.writeFileSync).mockReset();
});

describe("getWorkerId", () => {
  it("returns existing id from file", () => {
    vi.mocked(fs.readFileSync).mockReturnValue("existing-uuid\n" as any);
    expect(getWorkerId()).toBe("existing-uuid");
  });

  it("generates and saves a new uuid when file missing", () => {
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw new Error("ENOENT"); });
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
    const id = getWorkerId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(fs.writeFileSync).toHaveBeenCalledWith(".worker-id", id);
  });
});
