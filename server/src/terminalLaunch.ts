type LaunchSpec = {
  environment: { name: "CODEX_HOME" | "CLAUDE_CONFIG_DIR"; value: string } | null;
  executable: "codex" | "claude";
  args: string[];
};

/** Parse only the deliberately small, POSIX-quoted command shape emitted by
 * the black-window UI. Persisted launch commands can arrive through a restored
 * backup, so treating them as arbitrary shell text would turn layout data into
 * code execution on the next daemon start. */
export function parseTerminalLaunchCommand(command: string): LaunchSpec | null {
  if (!command || command.length > 8_000 || /[\r\n\0]/.test(command)) return null;
  const tokens: string[] = [];
  let current = "";
  let quoted = false;
  let escaped = false;
  let tokenStarted = false;
  for (const char of command.trim()) {
    if (escaped) { current += char; escaped = false; tokenStarted = true; continue; }
    if (!quoted && char === "\\") { escaped = true; tokenStarted = true; continue; }
    if (char === "'") { quoted = !quoted; tokenStarted = true; continue; }
    if (!quoted && /\s/.test(char)) {
      if (tokenStarted) { tokens.push(current); current = ""; tokenStarted = false; }
      continue;
    }
    current += char;
    tokenStarted = true;
  }
  if (quoted || escaped) return null;
  if (tokenStarted) tokens.push(current);

  let environment: LaunchSpec["environment"] = null;
  const assignment = /^(CODEX_HOME|CLAUDE_CONFIG_DIR)=(.*)$/s.exec(tokens[0] ?? "");
  if (assignment) {
    environment = { name: assignment[1] as "CODEX_HOME" | "CLAUDE_CONFIG_DIR", value: assignment[2] };
    tokens.shift();
  }
  const executable = tokens.shift();
  if (executable !== "codex" && executable !== "claude") return null;
  if ((executable === "codex" && environment?.name === "CLAUDE_CONFIG_DIR") || (executable === "claude" && environment?.name === "CODEX_HOME")) return null;
  return { environment, executable, args: tokens };
}

function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function powershellUtf8(value: string): string {
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value, "utf8").toString("base64")}'))`;
}

/** Build a command safe for the daemon's interactive platform shell. Windows
 * uses an encoded PowerShell program so cmd.exe never parses account paths,
 * model names, or other argument data as metacharacters. */
export function terminalLaunchCommand(command: string, platform: NodeJS.Platform = process.platform): string | null {
  const spec = parseTerminalLaunchCommand(command);
  if (!spec) return null;
  if (platform !== "win32") {
    const environment = spec.environment ? `${spec.environment.name}=${posixQuote(spec.environment.value)} ` : "";
    return environment + [spec.executable, ...spec.args].map(posixQuote).join(" ");
  }
  const setEnvironment = spec.environment ? `$env:${spec.environment.name}=${powershellUtf8(spec.environment.value)};` : "";
  const args = spec.args.map(powershellUtf8).join(",");
  const script = `${setEnvironment}$launchArgs=@(${args});& (${powershellUtf8(spec.executable)}) @launchArgs; exit $LASTEXITCODE`;
  return `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
}
