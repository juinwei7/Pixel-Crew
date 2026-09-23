' Launch the Tailscale reverse-proxy / mobile login gate, hidden window.
' Self-locating: prefer runtime\node.exe next to this script, else "node" on PATH.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
' Hand the relay the same startup log the server reads back: without it a Windows
' launch failure (port in use, missing node) is swallowed and the remote-access
' window can only say "relay not started". Children inherit the PROCESS scope.
Set env = sh.Environment("PROCESS")
env("PC_TSPROXY_LOG") = dir & "\_tsproxy.startup.log"
node = dir & "\runtime\node.exe"
If Not fso.FileExists(node) Then node = "node"
sh.Run """" & node & """ """ & dir & "\_tsproxy.mjs""", 0, False
