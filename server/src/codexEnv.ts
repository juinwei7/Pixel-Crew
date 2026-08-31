// Extracted to its own leaf module (no imports) so both codexRunner.ts and
// codexCapabilities.ts can use it without an import cycle — those two files
// already import from each other (codexRunner.ts uses
// parseCodexMcpServerStatus from codexCapabilities.ts).
export function codexChildEnv(source: NodeJS.ProcessEnv, codexHome?: string | null): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) if (key.startsWith("CODEX_") && key !== "CODEX_HOME") delete env[key];
  if (codexHome) env.CODEX_HOME = codexHome;
  return env;
}
