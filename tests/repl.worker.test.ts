import { describe, it, expect } from "vitest";
import * as http from "http";
import { WebSocket } from "ws";
import { createForemanWss, WorkerRegistry, TaskQueue } from "../src/foreman.js";

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
  it("worker connects to foreman at /worker path", async () => {
    const { port, close } = await startTestForeman();
    const FOREMAN_URL = `ws://localhost:${port}`;

    // This is the exact URL construction used in workerMain's connectWs
    const ws = new WebSocket(`${FOREMAN_URL}/worker`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });

    ws.close();
    close();
  });

  it("foreman rejects connections not at /worker (regression guard)", async () => {
    const { port, close } = await startTestForeman();
    const FOREMAN_URL = `ws://localhost:${port}`;

    // The original bug: connecting to the bare URL gets socket.destroy()'d by foreman
    const ws = new WebSocket(FOREMAN_URL);
    await expect(
      new Promise<void>((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
      })
    ).rejects.toThrow();

    close();
  });
});
