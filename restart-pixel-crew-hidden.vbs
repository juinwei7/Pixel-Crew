' Launches restart-pixel-crew.cmd fully hidden (window style 0).
' node's windowsHide flag is ignored when detached:true, so spawning the
' cmd directly flashed a console on screen for the 3s countdown; wscript
' never shows one (same trick as dc-voice-bot's run-bot-hidden.vbs).
' ASCII ONLY in this file.
Dim shell, here
Set shell = CreateObject("WScript.Shell")
here = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
shell.Run Chr(34) & here & "restart-pixel-crew.cmd" & Chr(34), 0, False
