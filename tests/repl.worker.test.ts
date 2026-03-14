import { describe, it, expect } from "vitest";
import * as http from "http";
import { createForemanWss, WorkerRegistry, TaskQueue } from "../src/foreman.js";
import { connectToForeman } from "../src/repl.js";
import type { ForemanMessage } from "../src/types.js";

function startTestForeman(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer();
    const { wss } = createForemanWss(new TaskQueue(), new WorkerRegistry(), server);
    server.listen(0, () => {
      const { port } = server.address() as { port: number };
      resolve({ port, close: () => { wss.close(); server.close(); } });
    });
  });
}

describe("worker WebSocket connection", () => {
  it("worker client connects to foreman and completes handshake", async () => {
    const { port, close } = await startTestForeman();

    // connectToForeman is the real client code: constructs the /worker URL and sends worker_hello
    const ws = connectToForeman(`ws://localhost:${port}`, "test-worker-id");

    const msg = await new Promise<ForemanMessage>((resolve, reject) => {
      ws.on("message", (data) => resolve(JSON.parse(data.toString())));
      ws.on("error", reject);
    });

    expect(msg.type).toBe("standby");

    ws.close();
    close();
  });

  it("foreman rejects connections not at /worker path (regression guard)", async () => {
    const { port, close } = await startTestForeman();

    // Original bug: bare URL gets socket.destroy()'d by the real foreman routing
    const { WebSocket } = await import("ws");
    const ws = new WebSocket(`ws://localhost:${port}`);
    await expect(
      new Promise<void>((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
      })
    ).rejects.toThrow();

    close();
  });
});
