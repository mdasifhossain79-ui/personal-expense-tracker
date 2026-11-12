' Opens Ledger in its own app window (no browser tabs, no black console window).
' Starts the server in the background first if it is not already running.
Option Explicit
Dim sh, fso, dir, url, i, paths, p, exe
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
url = "http://localhost:3005/"
sh.CurrentDirectory = dir

Function IsUp()
  Dim h
  On Error Resume Next
  Set h = CreateObject("MSXML2.ServerXMLHTTP.6.0")
  h.setTimeouts 1000, 1000, 1000, 1000
  h.open "GET", url, False
  h.send
  IsUp = (Err.Number = 0)
  If IsUp Then IsUp = (h.status = 200)
  Err.Clear
  On Error GoTo 0
End Function

If Not IsUp() Then
  sh.Run """" & dir & "\start-server-hidden.bat""", 0, False
  For i = 1 To 60
    WScript.Sleep 1000
    If IsUp() Then Exit For
  Next
End If

paths = Array( _
  sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Microsoft\Edge\Application\msedge.exe", _
  sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Microsoft\Edge\Application\msedge.exe", _
  sh.ExpandEnvironmentStrings("%ProgramFiles%") & "\Google\Chrome\Application\chrome.exe", _
  sh.ExpandEnvironmentStrings("%ProgramFiles(x86)%") & "\Google\Chrome\Application\chrome.exe", _
  sh.ExpandEnvironmentStrings("%LocalAppData%") & "\Google\Chrome\Application\chrome.exe")
exe = ""
For Each p In paths
  If fso.FileExists(p) Then exe = p : Exit For
Next
If exe <> "" Then
  sh.Run """" & exe & """ --app=" & url, 1, False
Else
  sh.Run url
End If
