import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";

import { WS_COMPRESSION_THRESHOLD_BYTES, wsPerMessageDeflate } from "../src/wsCompression.js";

// 在 127.0.0.1 隨機 port 起一個只套相同壓縮設定的 ws server（不碰正式服務），驗證協商與收送。
async function withServer(onConnection: (socket: WebSocket) => void, run: (port: number) => Promise<void>): Promise<void> {
  const server = createServer();
  const wss = new WebSocketServer({ server, path: "/ws", perMessageDeflate: wsPerMessageDeflate });
  wss.on("connection", onConnection);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run((server.address() as AddressInfo).port);
  } finally {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("permessage-deflate 會協商成功，大小訊息都能正確收到", async () => {
  const big = JSON.stringify({ type: "snapshot", events: Array.from({ length: 500 }, (_, i) => ({ type: "text_delta", text: `chunk ${i}` })) });
  const small = JSON.stringify({ type: "event", workerId: "w", event: { type: "text_delta", text: "hi" } });
  assert.ok(Buffer.byteLength(big) > WS_COMPRESSION_THRESHOLD_BYTES);
  assert.ok(Buffer.byteLength(small) < WS_COMPRESSION_THRESHOLD_BYTES);
  await withServer((socket) => { socket.send(big); socket.send(small); }, async (port) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const received: string[] = [];
    await new Promise<void>((resolve, reject) => {
      client.on("message", (data) => {
        received.push(String(data));
        if (received.length === 2) resolve();
      });
      client.on("error", reject);
    });
    assert.match(client.extensions, /permessage-deflate/);
    assert.deepEqual(received, [big, small]);
    client.close();
  });
});

test("不支援壓縮的 client 仍可正常連線（向後相容）", async () => {
  const payload = "x".repeat(5_000);
  await withServer((socket) => socket.send(payload), async (port) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}/ws`, { perMessageDeflate: false });
    const message = await new Promise<string>((resolve, reject) => {
      client.on("message", (data) => resolve(String(data)));
      client.on("error", reject);
    });
    assert.equal(client.extensions, "");
    assert.equal(message, payload);
    client.close();
  });
});
