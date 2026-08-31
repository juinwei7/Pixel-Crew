' Normal Windows launcher: WScript starts PowerShell hidden, so Pixel Crew
' does not need a persistent CMD/PowerShell window. Keep this file ASCII-only
' for compatibility with Windows Script Host on localized Windows installs.
Option Explicit

Dim shell, here, argument, command
Set shell = CreateObject("WScript.Shell")
here = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
command = "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File " & Quote(here & "scripts\windows\start-pixel-crew.ps1") & " -Background"
For Each argument In WScript.Arguments
  command = command & " " & Quote(argument)
Next
shell.Run command, 0, False

Function Quote(value)
  Quote = Chr(34) & Replace(value, Chr(34), Chr(34) & Chr(34)) & Chr(34)
End Function
