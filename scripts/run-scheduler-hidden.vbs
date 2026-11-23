Option Explicit
Dim shell, command
If WScript.Arguments.Count <> 2 Then WScript.Quit 2
Set shell = CreateObject("WScript.Shell")
command = Chr(34) & WScript.Arguments(0) & Chr(34) & " " & _
    Chr(34) & WScript.Arguments(1) & Chr(34) & " --managed"
WScript.Quit shell.Run(command, 0, True)
