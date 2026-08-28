' Launch the Tailscale reverse-proxy / mobile login gate, hidden window.
' Self-locating: prefer runtime\node.exe next to this script, else "node" on PATH.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
node = dir & "\runtime\node.exe"
If Not fso.FileExists(node) Then node = "node"
sh.Run """" & node & """ """ & dir & "\_tsproxy.mjs""", 0, False
