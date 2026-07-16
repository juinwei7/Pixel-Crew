import { createInterface } from "node:readline";

const endpoint = process.env.PIXEL_CREW_APPROVAL_URL ?? "";
const token = process.env.PIXEL_CREW_APPROVAL_TOKEN ?? "";
const rl = createInterface({ input: process.stdin });

function respond(id: unknown, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function fail(id: unknown, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}

rl.on("line", (line) => {
  void handle(line);
});

async function handle(line: string): Promise<void> {
  let message: any;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    respond(message.id, {
      protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "pixel-crew-approval", version: "0.1.0" },
    });
    return;
  }
  if (message.method === "ping") {
    respond(message.id, {});
    return;
  }
  if (message.method === "tools/list") {
    respond(message.id, {
      tools: [{
        name: "approval_prompt",
        description: "Ask the local Pixel Crew user to approve or deny a Claude Code tool call.",
        inputSchema: {
          type: "object",
          properties: {
            tool_name: { type: "string" },
            input: { type: "object" },
            permission_suggestions: { type: "array", items: { type: "object" } },
          },
          required: ["tool_name", "input"],
          additionalProperties: true,
        },
      }],
    });
    return;
  }
  if (message.method !== "tools/call" || message.params?.name !== "approval_prompt") {
    fail(message.id, -32601, "Unknown tool");
    return;
  }
  if (!endpoint || !token) {
    fail(message.id, -32000, "Pixel Crew approval bridge is not configured");
    return;
  }
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(message.params.arguments ?? {}),
    });
    const payload = await response.json() as { behavior?: string; message?: string };
    if (!response.ok) throw new Error(payload.message ?? `Approval server returned ${response.status}`);
    respond(message.id, { content: [{ type: "text", text: JSON.stringify(payload) }] });
  } catch (error) {
    fail(message.id, -32000, (error as Error).message || "Approval bridge failed");
  }
}
