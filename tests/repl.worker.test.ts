import { describe, it, expect } from "vitest";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";

function makeForemanServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer();
    const wss = new WebSocketServer({ noServer: true });

    // Mirror foreman routing: only accept connections at /worker
    server.on("upgrade", (req, socket, head) => {
      if (req.url === "/worker") {
        wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
      } else {
        socket.destroy();
      }
    });

    server.listen(0, () => {
      const { port } = server.address() as { port: number };
      resolve({ port, close: () => { wss.close(); server.close(); } });
    });
  });
}

describe("worker WebSocket connection", () => {
  it("connects successfully when using /worker path", async () => {
    const { port, close } = await makeForemanServer();
    const baseUrl = `ws://localhost:${port}`;

    const ws = new WebSocket(`${baseUrl}/worker`);
    await new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });

    ws.close();
    close();
  });

  it("fails to connect when using bare foreman URL (without /worker)", async () => {
    const { port, close } = await makeForemanServer();
    const baseUrl = `ws://localhost:${port}`;

    // Connecting to the bare URL (the original bug) should fail
    const ws = new WebSocket(baseUrl);
    await expect(
      new Promise<void>((resolve, reject) => {
        ws.on("open", resolve);
        ws.on("error", reject);
      })
    ).rejects.toThrow();

    close();
  });
});
