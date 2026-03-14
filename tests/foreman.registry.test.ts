import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorkerRegistry } from "../src/foreman.js";

function fakeWs() {
  return { send: vi.fn(), close: vi.fn(), readyState: 1 } as any;
}

describe("WorkerRegistry", () => {
  let reg: WorkerRegistry;
  beforeEach(() => { reg = new WorkerRegistry(); });

  it("registers a worker and retrieves it", () => {
    reg.register("w1", fakeWs(), "idle");
    expect(reg.get("w1")).toMatchObject({ workerId: "w1", status: "idle" });
  });

  it("getIdleWorker returns an idle worker", () => {
    reg.register("w1", fakeWs(), "idle");
    expect(reg.getIdleWorker()?.workerId).toBe("w1");
  });

  it("getIdleWorker returns null when all busy", () => {
    reg.register("w1", fakeWs(), "busy");
    expect(reg.getIdleWorker()).toBeNull();
  });

  it("assignTask marks worker busy with taskId", () => {
    reg.register("w1", fakeWs(), "idle");
    reg.assignTask("w1", "42");
    const w = reg.get("w1")!;
    expect(w.status).toBe("busy");
    expect(w.currentTaskId).toBe("42");
  });

  it("releaseWorker marks worker idle and clears taskId", () => {
    reg.register("w1", fakeWs(), "busy");
    reg.assignTask("w1", "42");
    reg.releaseWorker("w1");
    const w = reg.get("w1")!;
    expect(w.status).toBe("idle");
    expect(w.currentTaskId).toBeUndefined();
  });

  it("remove deletes the worker", () => {
    reg.register("w1", fakeWs(), "idle");
    reg.remove("w1");
    expect(reg.get("w1")).toBeUndefined();
  });

  it("getWorkerForTask returns worker assigned to that task", () => {
    reg.register("w1", fakeWs(), "idle");
    reg.assignTask("w1", "42");
    expect(reg.getWorkerForTask("42")?.workerId).toBe("w1");
  });

  it("send serializes message and calls ws.send", () => {
    const ws = fakeWs();
    reg.register("w1", ws, "idle");
    reg.send("w1", { type: "standby" });
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "standby" }));
  });
});
