import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";
import type { CapabilityState, McpServerState, ModelOption } from "./capabilities.js";

const execFileAsync = promisify(execFile);

const FALLBACK_MODELS: ModelOption[] = [
  { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
  { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
  { id: "gpt-5.6-luna", label: "GPT-5.6 Luna" },
  { id: "gpt-5.5", label: "GPT-5.5" },
  { id: "gpt-5.4", label: "GPT-5.4" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
];

export function parseCodexMcpList(stdout: string): McpServerState[] {
  const parsed = JSON.parse(stdout) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item: any) => {
    if (!item || typeof item.name !== "string") return [];
    return [{ name: item.name, status: item.enabled === false ? "disabled" : "enabled" }];
  });
}

export function parseCodexModels(stdout: string): ModelOption[] {
  const parsed = JSON.parse(stdout) as any;
  if (!Array.isArray(parsed?.models)) return [];
  return parsed.models
    .filter((model: any) => model?.visibility === "list" && typeof model.slug === "string")
    .sort((a: any, b: any) => Number(a.priority ?? 999) - Number(b.priority ?? 999))
    .map((model: any) => ({
      id: model.slug,
      label: typeof model.display_name === "string" ? model.display_name : model.slug,
      description: typeof model.description === "string" ? model.description : undefined,
    }));
}

export class CodexCapabilityRegistry {
  private state: CapabilityState = {
    slashCommands: [],
    mcpServers: [],
    models: FALLBACK_MODELS,
    toolCount: null,
    loading: true,
    source: "empty",
    updatedAt: null,
    error: null,
  };

  constructor(private readonly onUpdate: (state: CapabilityState) => void) {}

  getState(): CapabilityState {
    return this.state;
  }

  async refresh(): Promise<void> {
    this.publish({ ...this.state, loading: true, error: null });
    const [mcpResult, modelResult] = await Promise.allSettled([
      execFileAsync(config.codexBin, ["mcp", "list", "--json"], {
        cwd: config.targetRepoPath,
        timeout: 15000,
        maxBuffer: 2 * 1024 * 1024,
      }),
      execFileAsync(config.codexBin, ["debug", "models"], {
        cwd: config.targetRepoPath,
        timeout: 15000,
        maxBuffer: 8 * 1024 * 1024,
      }),
    ]);

    const errors: string[] = [];
    let mcpServers = this.state.mcpServers;
    let models = this.state.models;
    if (mcpResult.status === "fulfilled") {
      try {
        mcpServers = parseCodexMcpList(mcpResult.value.stdout);
      } catch (error) {
        errors.push(`MCP: ${(error as Error).message}`);
      }
    } else {
      errors.push(`MCP: ${mcpResult.reason?.message ?? "讀取失敗"}`);
    }
    if (modelResult.status === "fulfilled") {
      try {
        const discovered = parseCodexModels(modelResult.value.stdout);
        if (discovered.length > 0) models = discovered;
      } catch (error) {
        errors.push(`Models: ${(error as Error).message}`);
      }
    } else {
      errors.push(`Models: ${modelResult.reason?.message ?? "讀取失敗"}`);
    }

    this.publish({
      ...this.state,
      mcpServers,
      models,
      loading: false,
      source: "live",
      updatedAt: new Date().toISOString(),
      error: errors.length > 0 ? errors.join("; ") : null,
    });
  }

  private publish(state: CapabilityState): void {
    this.state = state;
    this.onUpdate(state);
  }
}
