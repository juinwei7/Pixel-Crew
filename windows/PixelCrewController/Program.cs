using System.Diagnostics;
using System.Drawing;
using System.IO.Compression;
using System.Net.Http;
using System.Reflection;
using Microsoft.Win32;

namespace PixelCrewController;

internal static class Program
{
    private const string InstanceName = "Local\\PixelCrewController";
    private const string OpenSignalName = "Local\\PixelCrewControllerOpen";

    [STAThread]
    private static void Main(string[] args)
    {
        if (TryOpenExistingController()) return;
        var root = SingleFileInstaller.ResolveInstalledRoot(args);
        if (root is null) return;
        using var instance = new Mutex(initiallyOwned: true, InstanceName, out var isPrimary);
        using var openSignal = new EventWaitHandle(false, EventResetMode.AutoReset, OpenSignalName);
        if (!isPrimary)
        {
            openSignal.Set();
            return;
        }

        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        var port = ReadPort(args);
        var minimized = args.Any(argument => string.Equals(argument, "--minimized", StringComparison.OrdinalIgnoreCase));
        Application.Run(new ControllerApplicationContext(root, port, minimized, openSignal));
    }

    private static bool TryOpenExistingController()
    {
        try
        {
            using var signal = EventWaitHandle.OpenExisting(OpenSignalName);
            signal.Set();
            return true;
        }
        catch (WaitHandleCannotBeOpenedException) { return false; }
    }

    private static int ReadPort(string[] args)
    {
        for (var index = 0; index < args.Length - 1; index += 1)
        {
            if ((string.Equals(args[index], "--port", StringComparison.OrdinalIgnoreCase) ||
                 string.Equals(args[index], "-port", StringComparison.OrdinalIgnoreCase)) &&
                int.TryParse(args[index + 1], out var port) && port is > 0 and <= 65535)
            {
                return port;
            }
        }
        return 8787;
    }
}

internal static class SingleFileInstaller
{
    private const string PayloadName = "PixelCrewController.payload.zip";
    private const string ExecutableName = "Pixel Crew.exe";
    private const string InstallerMutexName = "Local\\PixelCrewInstaller";

    public static string? ResolveInstalledRoot(string[] args)
    {
        using var installerMutex = new Mutex(initiallyOwned: true, InstallerMutexName, out var ownsInstaller);
        if (!ownsInstaller) return null;
        var dataRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Pixel Crew");
        var installRoot = Path.Combine(dataRoot, "app");
        var installedExecutable = Path.Combine(installRoot, ExecutableName);
        var currentExecutable = Application.ExecutablePath;
        if (PathsEqual(currentExecutable, installedExecutable)) return installRoot;

        // Source/debug builds retain the conventional local layout. Published
        // releases always carry the embedded payload and take the branch below.
        if (!HasEmbeddedPayload()) return AppContext.BaseDirectory;

        // A controller may have been closed while intentionally keeping Node
        // alive. Do not overwrite runtime files it still has open; reattach to
        // the existing installed control center instead.
        if (HasRunningManagedServer(dataRoot) && File.Exists(installedExecutable))
        {
            Process.Start(new ProcessStartInfo { FileName = installedExecutable, UseShellExecute = true });
            return null;
        }

        string? backup = null;
        string? staging = null;
        try
        {
            Directory.CreateDirectory(dataRoot);
            staging = Path.Combine(dataRoot, $"app-staging-{Guid.NewGuid():N}");
            Directory.CreateDirectory(staging);
            using (var payload = Assembly.GetExecutingAssembly().GetManifestResourceStream(PayloadName)
                   ?? throw new InvalidOperationException("內附應用程式 payload 遺失。請重新下載 Pixel Crew.exe。"))
            using (var archive = new ZipArchive(payload, ZipArchiveMode.Read))
            {
                archive.ExtractToDirectory(staging);
            }
            File.Copy(currentExecutable, Path.Combine(staging, ExecutableName), overwrite: true);

            if (Directory.Exists(installRoot))
            {
                backup = Path.Combine(dataRoot, $"app.previous-{Guid.NewGuid():N}");
                Directory.Move(installRoot, backup);
            }
            Directory.Move(staging, installRoot);
            staging = null;
            if (backup is not null) Directory.Delete(backup, recursive: true);

            var restart = new ProcessStartInfo { FileName = installedExecutable, UseShellExecute = true };
            foreach (var argument in args) restart.ArgumentList.Add(argument);
            Process.Start(restart);
            return null;
        }
        catch (Exception exception)
        {
            try
            {
                if (backup is not null && !Directory.Exists(installRoot) && Directory.Exists(backup)) Directory.Move(backup, installRoot);
            }
            catch { }
            WriteInstallError(exception.Message);
            MessageBox.Show($"Pixel Crew 無法完成安裝。\n\n{exception.Message}\n\n詳細資料：{LogDirectory}", "Pixel Crew", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return null;
        }
        finally
        {
            if (staging is not null && Directory.Exists(staging))
            {
                try { Directory.Delete(staging, recursive: true); } catch { }
            }
        }
    }

    private static string LogDirectory => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Pixel Crew", "logs");

    private static bool HasEmbeddedPayload() => Assembly.GetExecutingAssembly().GetManifestResourceInfo(PayloadName) is not null;

    private static bool HasRunningManagedServer(string dataRoot)
    {
        var pidFile = Path.Combine(dataRoot, "logs", "server.pid");
        try
        {
            if (!int.TryParse(File.ReadAllText(pidFile).Trim(), out var processId)) return false;
            using var server = Process.GetProcessById(processId);
            return !server.HasExited;
        }
        catch (Exception exception) when (exception is ArgumentException or IOException or InvalidOperationException or UnauthorizedAccessException)
        {
            try { File.Delete(pidFile); } catch { }
            return false;
        }
    }

    private static bool PathsEqual(string left, string right) =>
        string.Equals(Path.GetFullPath(left), Path.GetFullPath(right), StringComparison.OrdinalIgnoreCase);

    private static void WriteInstallError(string message)
    {
        try
        {
            Directory.CreateDirectory(LogDirectory);
            File.AppendAllText(Path.Combine(LogDirectory, "installer-error.log"), $"{DateTimeOffset.Now:O} {message}{Environment.NewLine}");
        }
        catch { }
    }
}

internal enum ServiceState { Starting, Running, Stopped, Error, External }

internal sealed class ControllerApplicationContext : ApplicationContext
{
    private readonly PixelCrewHost host;
    private readonly NotifyIcon trayIcon;
    private readonly ToolStripMenuItem statusItem;
    private readonly ToolStripMenuItem openItem;
    private readonly ToolStripMenuItem restartItem;
    private readonly ToolStripMenuItem stopItem;
    private readonly ToolStripMenuItem autoStartItem;
    private readonly System.Windows.Forms.Timer healthTimer;
    private readonly System.Windows.Forms.Timer openSignalTimer;
    private readonly ControlCenterForm window;
    private readonly EventWaitHandle openSignal;
    private bool exiting;

    public ControllerApplicationContext(string root, int port, bool minimized, EventWaitHandle openSignal)
    {
        this.openSignal = openSignal;
        host = new PixelCrewHost(root, port);
        host.StateChanged += (_, _) => OnUi(UpdateUi);
        host.Faulted += (_, fault) => OnUi(() => ShowFault(fault));

        statusItem = new ToolStripMenuItem("正在檢查 Pixel Crew…") { Enabled = false };
        openItem = new ToolStripMenuItem("開啟", null, (_, _) => OpenPixelCrew());
        restartItem = new ToolStripMenuItem("重新啟動", null, async (_, _) => await host.RestartAsync());
        stopItem = new ToolStripMenuItem("停止", null, async (_, _) => await host.StopAsync());
        var logsItem = new ToolStripMenuItem("查看記錄", null, (_, _) => host.OpenLogs());
        autoStartItem = new ToolStripMenuItem("開機自動啟動") { CheckOnClick = true, Checked = AutoStart.IsEnabled() };
        autoStartItem.CheckedChanged += (_, _) => AutoStart.SetEnabled(autoStartItem.Checked);
        var exitItem = new ToolStripMenuItem("結束控制中心…", null, async (_, _) => await RequestExitAsync());
        var menu = new ContextMenuStrip();
        menu.Items.AddRange([statusItem, openItem, restartItem, stopItem, logsItem, new ToolStripSeparator(), autoStartItem, new ToolStripSeparator(), exitItem]);

        trayIcon = new NotifyIcon
        {
            Icon = ProductIcon.Load(),
            Text = "Pixel Crew",
            ContextMenuStrip = menu,
            Visible = true,
        };
        trayIcon.DoubleClick += (_, _) => ShowControlCenter();

        window = new ControlCenterForm(host, OpenPixelCrew);
        window.FormClosing += async (_, eventArgs) =>
        {
            if (exiting) return;
            eventArgs.Cancel = true;
            await RequestExitAsync();
        };

        healthTimer = new System.Windows.Forms.Timer { Interval = 3000 };
        healthTimer.Tick += async (_, _) => await host.RefreshAsync();
        healthTimer.Start();
        openSignalTimer = new System.Windows.Forms.Timer { Interval = 400 };
        openSignalTimer.Tick += (_, _) =>
        {
            if (openSignal.WaitOne(0)) ShowControlCenter();
        };
        openSignalTimer.Start();
        UpdateUi();
        _ = StartAndMaybeOpenAsync(!minimized);
        if (!minimized) ShowControlCenter();
    }

    private async Task StartAndMaybeOpenAsync(bool openBrowser)
    {
        await host.StartIfNeededAsync();
        if (openBrowser && (host.State is ServiceState.Running or ServiceState.External)) host.OpenBrowser();
    }

    private void ShowControlCenter()
    {
        if (!window.Visible) window.Show();
        window.WindowState = FormWindowState.Normal;
        window.Activate();
        window.BringToFront();
    }

    private void OpenPixelCrew()
    {
        ShowControlCenter();
        host.OpenBrowser();
    }

    private void OnUi(Action action)
    {
        if (window.IsDisposed) return;
        if (window.IsHandleCreated && window.InvokeRequired) window.BeginInvoke(action);
        else action();
    }

    private void UpdateUi()
    {
        var (caption, canOpen, canRestart, canStop) = host.State switch
        {
            ServiceState.Running => ("Pixel Crew 正在執行", true, true, true),
            ServiceState.External => ("Pixel Crew 由另一個啟動器執行", true, false, false),
            ServiceState.Starting => ("Pixel Crew 正在啟動…", false, false, false),
            ServiceState.Error => ("Pixel Crew 發生錯誤", false, true, false),
            _ => ("Pixel Crew 已停止", false, true, false),
        };
        statusItem.Text = caption;
        openItem.Enabled = canOpen;
        restartItem.Enabled = canRestart;
        stopItem.Enabled = canStop;
        trayIcon.Text = caption;
        window.UpdateState(caption, canOpen, canRestart, canStop);
    }

    private void ShowFault(HostFault fault)
    {
        trayIcon.ShowBalloonTip(8000, "Pixel Crew 發生錯誤", fault.Message, ToolTipIcon.Error);
        using var dialog = new ErrorDialog(fault, host.OpenLogs);
        dialog.ShowDialog(window);
    }

    private async Task RequestExitAsync()
    {
        if (exiting) return;
        using var dialog = new ExitChoiceDialog();
        var choice = dialog.ShowDialog(window);
        if (choice == DialogResult.Cancel) return;
        if (choice == DialogResult.OK) await host.StopAsync();
        exiting = true;
        ExitThread();
    }

    protected override void ExitThreadCore()
    {
        healthTimer.Stop();
        openSignalTimer.Stop();
        trayIcon.Visible = false;
        trayIcon.Dispose();
        host.Dispose();
        base.ExitThreadCore();
    }
}

internal sealed class PixelCrewHost : IDisposable
{
    private readonly string root;
    private readonly int port;
    private readonly string logsDirectory;
    private readonly string pidFile;
    private readonly string updateMarker;
    private readonly HttpClient httpClient = new() { Timeout = TimeSpan.FromSeconds(1) };
    private Process? process;
    private bool stopping;

    public PixelCrewHost(string root, int port)
    {
        this.root = root;
        this.port = port;
        logsDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Pixel Crew", "logs");
        pidFile = Path.Combine(logsDirectory, "server.pid");
        updateMarker = Path.Combine(logsDirectory, "update.pending");
    }

    public ServiceState State { get; private set; } = ServiceState.Stopped;
    public event EventHandler? StateChanged;
    public event EventHandler<HostFault>? Faulted;

    public async Task StartIfNeededAsync()
    {
        if (await IsHealthyAsync())
        {
            if (TryAdoptExistingServer()) SetState(ServiceState.Running);
            else SetState(ServiceState.External);
            return;
        }
        await StartAsync();
    }

    public async Task RestartAsync()
    {
        if (State == ServiceState.External)
        {
            RaiseFault("無法重新啟動", "目前服務不是由這個 Pixel Crew 控制中心啟動。請先關閉原本的啟動器後再試一次。");
            return;
        }
        await StopAsync();
        await StartAsync();
    }

    public async Task StartAsync()
    {
        if (process is { HasExited: false }) return;
        var nodePath = Path.Combine(root, "runtime", "node.exe");
        var serverPath = Path.Combine(root, "server", "dist", "index.js");
        if (!File.Exists(nodePath) || !File.Exists(serverPath))
        {
            RaiseFault("Pixel Crew 無法啟動", "找不到內附 Node.js runtime 或伺服器檔案。請重新下載 Pixel Crew.exe。 ");
            SetState(ServiceState.Error);
            return;
        }

        try
        {
            Directory.CreateDirectory(logsDirectory);
            stopping = false;
            SetState(ServiceState.Starting);
            var startInfo = new ProcessStartInfo(nodePath)
            {
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            startInfo.ArgumentList.Add("server/dist/index.js");
            startInfo.ArgumentList.Add("--serve-web");
            startInfo.Environment["PORT"] = port.ToString();
            process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
            process.OutputDataReceived += (_, line) => AppendLog("server.stdout.log", line.Data);
            process.ErrorDataReceived += (_, line) => AppendLog("server.stderr.log", line.Data);
            process.Exited += (_, _) => OnProcessExited();
            if (!process.Start()) throw new InvalidOperationException("無法建立 Node.js 程序。");
            File.WriteAllText(pidFile, process.Id.ToString());
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();

            for (var attempt = 0; attempt < 40; attempt += 1)
            {
                if (process.HasExited) throw new InvalidOperationException($"服務啟動失敗（exit code {process.ExitCode}）。");
                if (await IsHealthyAsync())
                {
                    SetState(ServiceState.Running);
                    return;
                }
                await Task.Delay(250);
            }
            throw new TimeoutException("服務啟動逾時。請查看記錄或執行 Windows Doctor。 ");
        }
        catch (Exception exception)
        {
            stopping = true;
            TryKillProcess();
            TryDeletePidFile();
            SetState(ServiceState.Error);
            RaiseFault("Pixel Crew 無法啟動", exception.Message);
        }
    }

    public async Task StopAsync()
    {
        stopping = true;
        if (process is { HasExited: false })
        {
            var server = process;
            TryKillProcess();
            await Task.Run(() => server.WaitForExit(5000));
        }
        TryDeletePidFile();
        process?.Dispose();
        process = null;
        SetState(ServiceState.Stopped);
    }

    public async Task RefreshAsync()
    {
        if (State == ServiceState.Starting) return;
        var healthy = await IsHealthyAsync();
        if (healthy && process is { HasExited: false }) SetState(ServiceState.Running);
        else if (healthy && process is null) SetState(ServiceState.External);
        else if (!healthy && State is ServiceState.Running or ServiceState.External) SetState(ServiceState.Stopped);
    }

    public void OpenLogs()
    {
        Directory.CreateDirectory(logsDirectory);
        Process.Start(new ProcessStartInfo { FileName = logsDirectory, UseShellExecute = true });
    }

    public void OpenBrowser() => Process.Start(new ProcessStartInfo
    {
        FileName = $"http://127.0.0.1:{port}",
        UseShellExecute = true,
    });

    private async Task<bool> IsHealthyAsync()
    {
        try
        {
            using var response = await httpClient.GetAsync($"http://127.0.0.1:{port}/healthz");
            return response.IsSuccessStatusCode;
        }
        catch (HttpRequestException) { return false; }
        catch (TaskCanceledException) { return false; }
    }

    private void OnProcessExited()
    {
        if (stopping) return;
        TryDeletePidFile();
        if (File.Exists(updateMarker))
        {
            SetState(ServiceState.Stopped);
            return;
        }
        var exitCode = process?.ExitCode;
        SetState(ServiceState.Error);
        RaiseFault("Pixel Crew 已停止", $"內附服務意外結束（exit code {exitCode}）。");
        _ = RestartAfterUnexpectedExitAsync();
    }

    private async Task RestartAfterUnexpectedExitAsync()
    {
        await Task.Delay(750);
        if (!stopping) await StartAsync();
    }

    private void TryKillProcess()
    {
        try { process?.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
    }

    private bool TryAdoptExistingServer()
    {
        try
        {
            if (!int.TryParse(File.ReadAllText(pidFile).Trim(), out var processId)) return false;
            var candidate = Process.GetProcessById(processId);
            if (candidate.HasExited || !PathsEqual(candidate.MainModule?.FileName, Path.Combine(root, "runtime", "node.exe")))
            {
                candidate.Dispose();
                TryDeletePidFile();
                return false;
            }
            process = candidate;
            process.EnableRaisingEvents = true;
            process.Exited += (_, _) => OnProcessExited();
            return true;
        }
        catch (Exception exception) when (exception is ArgumentException or IOException or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            TryDeletePidFile();
            return false;
        }
    }

    private static bool PathsEqual(string? left, string right) =>
        left is not null && string.Equals(Path.GetFullPath(left), Path.GetFullPath(right), StringComparison.OrdinalIgnoreCase);

    private void TryDeletePidFile()
    {
        try { File.Delete(pidFile); } catch (IOException) { }
    }

    private void AppendLog(string fileName, string? line)
    {
        if (string.IsNullOrWhiteSpace(line)) return;
        try { File.AppendAllText(Path.Combine(logsDirectory, fileName), $"{DateTimeOffset.Now:O} {line}{Environment.NewLine}"); } catch (IOException) { }
    }

    private void SetState(ServiceState state)
    {
        if (State == state) return;
        State = state;
        StateChanged?.Invoke(this, EventArgs.Empty);
    }

    private void RaiseFault(string title, string message) => Faulted?.Invoke(this, new HostFault(title, message));

    public void Dispose()
    {
        httpClient.Dispose();
        process?.Dispose();
    }
}

internal sealed record HostFault(string Title, string Message);

internal static class AutoStart
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "Pixel Crew Control Center";

    public static bool IsEnabled() => Registry.CurrentUser.OpenSubKey(RunKey)?.GetValue(ValueName) is string;

    public static void SetEnabled(bool enabled)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKey, writable: true);
        if (enabled) key.SetValue(ValueName, $"\"{Application.ExecutablePath}\" --minimized");
        else key.DeleteValue(ValueName, throwOnMissingValue: false);
    }
}

internal static class ProductIcon
{
    [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Auto)]
    private static extern bool DestroyIcon(IntPtr handle);

    public static Icon Load()
    {
        var assembly = Assembly.GetExecutingAssembly();
        using var stream = assembly.GetManifestResourceStream("PixelCrewController.Assets.pixel-crew.png");
        using var bitmap = stream is null ? new Bitmap(SystemIcons.Application.ToBitmap()) : new Bitmap(stream);
        var handle = bitmap.GetHicon();
        try { return Icon.FromHandle(handle).Clone() as Icon ?? SystemIcons.Application; }
        finally { DestroyIcon(handle); }
    }
}

internal sealed class ControlCenterForm : Form
{
    private readonly Label stateLabel = new() { AutoSize = true, Font = new Font(SystemFonts.DefaultFont, FontStyle.Bold) };
    private readonly Button openButton = new() { Text = "開啟 Pixel Crew" };
    private readonly Button restartButton = new() { Text = "重新啟動" };
    private readonly Button stopButton = new() { Text = "停止" };

    public ControlCenterForm(PixelCrewHost host, Action open)
    {
        Text = "Pixel Crew 控制中心";
        Icon = ProductIcon.Load();
        MinimumSize = new Size(420, 235);
        Size = new Size(480, 280);
        StartPosition = FormStartPosition.CenterScreen;
        var title = new Label { Text = "Pixel Crew 控制中心", AutoSize = true, Font = new Font(SystemFonts.DefaultFont.FontFamily, 16, FontStyle.Bold), Location = new Point(24, 22) };
        stateLabel.Location = new Point(26, 68);
        var description = new Label { Text = "本機服務只會開放給這台電腦的瀏覽器。", AutoSize = true, Location = new Point(26, 98) };
        openButton.Location = new Point(25, 145);
        restartButton.Location = new Point(160, 145);
        stopButton.Location = new Point(275, 145);
        var logsButton = new Button { Text = "查看記錄", Location = new Point(25, 187) };
        openButton.Click += (_, _) => open();
        restartButton.Click += async (_, _) => await host.RestartAsync();
        stopButton.Click += async (_, _) => await host.StopAsync();
        logsButton.Click += (_, _) => host.OpenLogs();
        Controls.AddRange([title, stateLabel, description, openButton, restartButton, stopButton, logsButton]);
    }

    public void UpdateState(string state, bool canOpen, bool canRestart, bool canStop)
    {
        stateLabel.Text = state;
        openButton.Enabled = canOpen;
        restartButton.Enabled = canRestart;
        stopButton.Enabled = canStop;
    }
}

internal sealed class ErrorDialog : Form
{
    public ErrorDialog(HostFault fault, Action openLogs)
    {
        Text = fault.Title;
        StartPosition = FormStartPosition.CenterParent;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MinimizeBox = false;
        MaximizeBox = false;
        ClientSize = new Size(500, 185);
        var message = new Label { Text = fault.Message, AutoSize = false, Location = new Point(20, 22), Size = new Size(460, 72) };
        var details = new Button { Text = "查看詳細資料", Location = new Point(20, 125), AutoSize = true };
        var close = new Button { Text = "關閉", DialogResult = DialogResult.OK, Location = new Point(398, 125), AutoSize = true };
        details.Click += (_, _) => openLogs();
        Controls.AddRange([message, details, close]);
        AcceptButton = close;
    }
}

internal sealed class ExitChoiceDialog : Form
{
    public ExitChoiceDialog()
    {
        Text = "結束 Pixel Crew 控制中心";
        StartPosition = FormStartPosition.CenterParent;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MinimizeBox = false;
        MaximizeBox = false;
        ClientSize = new Size(480, 175);
        var message = new Label { Text = "要讓 Pixel Crew 的本機服務繼續執行嗎？", AutoSize = true, Location = new Point(22, 25) };
        var keepRunning = new Button { Text = "只關閉圖示", DialogResult = DialogResult.Ignore, Location = new Point(22, 102), AutoSize = true };
        var stopService = new Button { Text = "停止服務並結束", DialogResult = DialogResult.OK, Location = new Point(151, 102), AutoSize = true };
        var cancel = new Button { Text = "取消", DialogResult = DialogResult.Cancel, Location = new Point(370, 102), AutoSize = true };
        Controls.AddRange([message, keepRunning, stopService, cancel]);
        CancelButton = cancel;
    }
}
