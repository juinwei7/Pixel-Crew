import { execCli } from "./processes.js";
import { t } from "../i18n.js";

export type DirectoryPickerResult = { path?: string; canceled?: boolean };

const WINDOWS_PICKER_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Pixel Crew: Select a workspace folder'
$dialog.ShowNewFolderButton = $false
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  Write-Output $dialog.SelectedPath
} else { exit 2 }
`.trim();

export async function pickDirectory(platform: NodeJS.Platform = process.platform): Promise<DirectoryPickerResult> {
  try {
    if (platform === "darwin") {
      const { stdout } = await execCli("/usr/bin/osascript", [
        "-e",
        `POSIX path of (choose folder with prompt "Pixel Crew：${t("選擇工作資料夾")}")`,
      ], { timeout: 120_000 });
      return { path: stdout.trim() };
    }
    if (platform === "win32") {
      let lastError: unknown;
      for (const shell of ["pwsh.exe", "powershell.exe"]) {
        try {
          const { stdout } = await execCli(shell, ["-NoLogo", "-NoProfile", "-STA", "-Command", WINDOWS_PICKER_SCRIPT], {
            timeout: 120_000,
            windowsHide: true,
          });
          return { path: stdout.trim() };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "2") return { canceled: true };
          lastError = error;
        }
      }
      throw lastError;
    }
    throw new Error(t("目前平台不支援原生資料夾選擇器"));
  } catch (error) {
    const detail = String((error as any)?.stderr ?? (error as Error)?.message ?? error);
    if (/cancel|取消|-128|code 2|exited with code 2/i.test(detail)) return { canceled: true };
    throw error;
  }
}
