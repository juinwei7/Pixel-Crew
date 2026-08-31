// Mirrors codexEnv.ts. Own leaf module (no imports) so claudeRunner.ts and
// capabilities.ts can both use it without risking an import cycle.
export function claudeChildEnv(source: NodeJS.ProcessEnv, claudeHome?: string | null): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) if (key.startsWith("CLAUDE_") && key !== "CLAUDE_CONFIG_DIR") delete env[key];
  if (claudeHome) env.CLAUDE_CONFIG_DIR = claudeHome;
  return env;
}
