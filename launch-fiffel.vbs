' Fiffel quick launcher.
' Builds the app, then starts it without leaving a console window open.
Option Explicit

Dim shell, fso, root, electron, outMain, rc

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

root = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root

electron = root & "\node_modules\electron\dist\electron.exe"
outMain = root & "\out\main\index.js"

If Not fso.FileExists(electron) Then
  MsgBox "Electron runtime not found. Run npm install in:" & vbCrLf & root, 48, "Fiffel"
  WScript.Quit 1
End If

' Rebuild so the window always shows the latest source.
rc = shell.Run("npm.cmd run build", 0, True)

If rc <> 0 Or Not fso.FileExists(outMain) Then
  MsgBox "Build failed. Open a terminal in:" & vbCrLf & root & vbCrLf & "then run: npm.cmd run build", 16, "Fiffel"
  WScript.Quit 1
End If

shell.Run """" & electron & """ """ & root & """", 1, False
