import AppKit
import Darwin
import Foundation

private let pixelCrewURL = URL(string: "http://127.0.0.1:8787")!
private let healthURL = pixelCrewURL.appendingPathComponent("healthz")

final class PixelCrewAppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var server: Process?
    private var logHandle: FileHandle?
    private var healthTimer: Timer?
    private var healthAttempts = 0
    private var healthCheckInFlight = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        configureMenu()
        checkHealth { [weak self] healthy in
            DispatchQueue.main.async {
                guard let self else { return }
                if healthy {
                    self.openPixelCrew()
                } else {
                    self.startServer()
                }
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        healthTimer?.invalidate()
        if let server, server.isRunning {
            server.terminate()
            let deadline = Date().addingTimeInterval(2)
            while server.isRunning && Date() < deadline {
                RunLoop.current.run(until: Date().addingTimeInterval(0.05))
            }
            if server.isRunning {
                kill(server.processIdentifier, SIGKILL)
            }
        }
        logHandle?.closeFile()
    }

    private func configureMenu() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "PC"
        statusItem.button?.toolTip = "Pixel Crew"

        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Open Pixel Crew", action: #selector(openPixelCrew), keyEquivalent: "o"))
        menu.addItem(NSMenuItem(title: "Open Log", action: #selector(openLog), keyEquivalent: "l"))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit Pixel Crew", action: #selector(quitPixelCrew), keyEquivalent: "q"))
        for item in menu.items { item.target = self }
        statusItem.menu = menu
    }

    private func startServer() {
        guard let resources = Bundle.main.resourceURL else {
            showFatalError("Pixel Crew app resources are missing.")
            return
        }
        let runtime = resources.appendingPathComponent("runtime/bin/node")
        let appRoot = resources.appendingPathComponent("app", isDirectory: true)
        let entrypoint = appRoot.appendingPathComponent("server/dist/index.js")
        guard FileManager.default.isExecutableFile(atPath: runtime.path),
              FileManager.default.fileExists(atPath: entrypoint.path) else {
            showFatalError("Pixel Crew runtime is incomplete. Reinstall the app from the official release.")
            return
        }

        do {
            let logURL = try launcherLogURL()
            if !FileManager.default.fileExists(atPath: logURL.path) {
                FileManager.default.createFile(atPath: logURL.path, contents: nil)
            }
            let handle = try FileHandle(forWritingTo: logURL)
            try handle.seekToEnd()
            logHandle = handle

            var environment = ProcessInfo.processInfo.environment
            environment["NODE_ENV"] = "production"
            environment["WEB_DIST_PATH"] = appRoot.appendingPathComponent("web/dist").path
            environment["PATH"] = providerPath(existing: environment["PATH"])

            let process = Process()
            process.executableURL = runtime
            process.arguments = [entrypoint.path, "--serve-web"]
            process.currentDirectoryURL = appRoot
            process.environment = environment
            process.standardOutput = handle
            process.standardError = handle
            process.terminationHandler = { [weak self, weak process] _ in
                DispatchQueue.main.async {
                    guard let self, let process, self.server === process else { return }
                    self.statusItem.button?.title = "PC!"
                }
            }
            try process.run()
            server = process
            statusItem.button?.title = "PC…"
            waitForHealth()
        } catch {
            showFatalError("Pixel Crew could not start: \(error.localizedDescription)")
        }
    }

    private func waitForHealth() {
        healthAttempts = 0
        healthCheckInFlight = false
        healthTimer?.invalidate()
        healthTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] timer in
            guard let self else { timer.invalidate(); return }
            guard !self.healthCheckInFlight else { return }
            self.healthCheckInFlight = true
            self.checkHealth { healthy in
                DispatchQueue.main.async {
                    self.healthCheckInFlight = false
                    self.healthAttempts += 1
                    guard healthy else {
                        if self.healthAttempts >= 40 {
                            timer.invalidate()
                            self.showFatalError("Pixel Crew did not become ready. Open the log for details.")
                        }
                        return
                    }
                    timer.invalidate()
                    self.statusItem.button?.title = "PC"
                    self.openPixelCrew()
                }
            }
        }
    }

    private func checkHealth(completion: @escaping (Bool) -> Void) {
        var request = URLRequest(url: healthURL)
        request.timeoutInterval = 1
        URLSession.shared.dataTask(with: request) { data, response, _ in
            guard let data,
                  (response as? HTTPURLResponse)?.statusCode == 200,
                  let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  payload["ok"] as? Bool == true else {
                completion(false)
                return
            }
            completion(true)
        }.resume()
    }

    private func providerPath(existing: String?) -> String {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let preferred = [
            "\(home)/.local/bin",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ]
        let inherited = (existing ?? "").split(separator: ":").map(String.init)
        var seen = Set<String>()
        return (preferred + inherited).filter { !$0.isEmpty && seen.insert($0).inserted }.joined(separator: ":")
    }

    private func launcherLogURL() throws -> URL {
        let base = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Pixel Crew", isDirectory: true)
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        return base.appendingPathComponent("launcher.log")
    }

    @objc private func openPixelCrew() {
        NSWorkspace.shared.open(pixelCrewURL)
    }

    @objc private func openLog() {
        do {
            NSWorkspace.shared.open(try launcherLogURL())
        } catch {
            showFatalError("Unable to open the Pixel Crew log: \(error.localizedDescription)")
        }
    }

    @objc private func quitPixelCrew() {
        NSApp.terminate(nil)
    }

    private func showFatalError(_ message: String) {
        statusItem.button?.title = "PC!"
        let alert = NSAlert()
        alert.messageText = "Pixel Crew"
        alert.informativeText = message
        alert.alertStyle = .critical
        alert.addButton(withTitle: "Open Log")
        alert.addButton(withTitle: "Quit")
        if alert.runModal() == .alertFirstButtonReturn {
            openLog()
        } else {
            quitPixelCrew()
        }
    }
}

let application = NSApplication.shared
let delegate = PixelCrewAppDelegate()
application.delegate = delegate
application.run()
