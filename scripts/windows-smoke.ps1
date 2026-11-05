# Installs bloomterm from its installer and uses it, as someone would on their own PC. GitHub's
# Windows machine is the only one this runs on, so every check runs even after one fails, and a
# screenshot and the logs go to the results folder.
#
# With an update folder (a newer version's installer and its latest.json) it also updates the app
# from it, on 127.0.0.1:8765, where an app built for this looks, then goes through Setup with the
# real agents. A release leaves both out: it shouldn't wait on Anthropic's or OpenAI's servers.
#
#   pwsh scripts/windows-smoke.ps1 <installer.exe> <results folder> [update folder]

param(
  [Parameter(Mandatory)] [string] $Installer,
  [Parameter(Mandatory)] [string] $Out,
  [string] $Update
)

$ErrorActionPreference = 'Continue'
$app = Join-Path $env:LOCALAPPDATA 'bloomterm'
$exe = Join-Path $app 'bloomterm.exe'
$node = Join-Path $app 'node.exe'
$bt = Join-Path $app 'bundle\bt.cmd'
$data = Join-Path $env:USERPROFILE '.bloomterm'
$log = Join-Path $data 'logs\bloomd.log'
$script:failures = 0
New-Item -ItemType Directory -Force $Out | Out-Null

function Check([string] $name, [scriptblock] $test) {
  $why = ''
  try { $ok = & $test | Select-Object -Last 1 } catch { $ok = $false; $why = $_.Exception.Message }
  if ($ok) {
    Write-Host "ok    $name"
  } else {
    Write-Host "FAIL  $name $why"
    $script:failures++
  }
}

function WaitFor([int] $seconds, [scriptblock] $test) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    try { if (& $test) { return $true } } catch {}
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Running { Get-Process bloomterm, node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$app\*" } }

function Bloomd { Get-Content -Raw -ErrorAction Stop (Join-Path $data 'state\bloomd.json') | ConvertFrom-Json }

function Healthy { (Invoke-RestMethod -TimeoutSec 3 "http://127.0.0.1:$((Bloomd).port)/api/health").name -eq 'bloomd' }

function Stops { (Select-String -Path $log -Pattern 'stopping.*shutdown').Count }

function Version { (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' | Where-Object DisplayName -EQ 'bloomterm').DisplayVersion }

# An app running as admin, as it does here, writes to HKLM; anyone else's to HKCU.
function OpensAtLogin {
  foreach ($hive in 'HKCU:', 'HKLM:') {
    (Get-ItemProperty "$hive\Software\Microsoft\Windows\CurrentVersion\Run").PSObject.Properties.Value -match 'bloomterm\.exe.*--hidden'
  }
}

function StartApp {
  Start-Process $exe
  WaitFor 90 { Healthy }
}

function Stopped { WaitFor 20 { -not (Running) } }

function Install { (Start-Process $Installer -ArgumentList '/S' -Wait -PassThru).ExitCode -eq 0 }

# The process's main window won't do: the app always has invisible ones of its own.
Add-Type -Namespace Win32 -Name Window -MemberDefinition @'
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string windowClass, string title);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
'@
function WindowShows { [Win32.Window]::IsWindowVisible([Win32.Window]::FindWindow([NullString]::Value, 'bloomterm')) }

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

function Screenshot([string] $name) {
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $image = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  [System.Drawing.Graphics]::FromImage($image).CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $image.Save((Join-Path $Out "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $true
}

# A key, with the page in the window in focus.
function Press([string] $keys) {
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  [Win32.Window]::SetCursorPos($bounds.Width / 2, $bounds.Height / 2) | Out-Null
  foreach ($button in 2, 4) { [Win32.Window]::mouse_event($button, 0, 0, 0, [UIntPtr]::Zero) }
  Start-Sleep -Milliseconds 500
  [System.Windows.Forms.SendKeys]::SendWait($keys)
  Start-Sleep -Seconds 2
}

function Api([string] $method, [string] $path) {
  $token = (Get-Content -Raw (Join-Path $data 'token')).Trim()
  Invoke-RestMethod -TimeoutSec 60 -Method $method -Headers @{ authorization = "Bearer $token" } "http://127.0.0.1:$((Bloomd).port)$path"
}

# What Setup says to paste, in Windows PowerShell as a new PC has it: running no script files. Its
# input is closed, so nothing stops to ask a question.
function Paste([string] $command) {
  Write-Host "> $command"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
  $null | powershell.exe -NoProfile -ExecutionPolicy Restricted -EncodedCommand $encoded 2>&1 | Write-Host
  $LASTEXITCODE -eq 0
}

Write-Host '--- install'
Check 'the installer finishes' { Install }
foreach ($file in 'bloomterm.exe', 'node.exe', 'uninstall.exe', 'bundle\bt.mjs', 'bundle\bt.cmd', 'bundle\web\index.html', 'bundle\kit') {
  Check "it installs $file" { Test-Path (Join-Path $app $file) }
}
Check 'the Start menu entry has the id toasts show under' {
  $programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
  $link = (New-Object -ComObject Shell.Application).NameSpace($programs).ParseName('bloomterm.lnk')
  $id = $link.ExtendedProperty('System.AppUserModel.ID')
  Write-Host "Start menu id: $id"
  $id -eq 'app.bloomterm.desktop'
}

Write-Host '--- the bundle, on the Node it ships with'
Check 'bt runs' { & $bt --help | Out-Null; $LASTEXITCODE -eq 0 }
Check 'the Credential Manager addon loads' { & $node -e 'require(process.argv[1])' (Join-Path $app 'bundle\node_modules\@napi-rs\keyring'); $LASTEXITCODE -eq 0 }
Check 'bt checks an integration against the bundled kit' {
  $folder = Join-Path ([IO.Path]::GetTempPath()) 'bcb'
  Copy-Item -Recurse (Join-Path $app 'bundle\integrations-src\bcb') $folder
  foreach ($file in Get-ChildItem $folder -Filter *.ts) {
    (Get-Content -Raw $file) -replace "'\.\./[a-z]+\.ts'", "'@bloomterm/sdk'" | Set-Content -NoNewline $file
  }
  & $bt check-integration $folder 2>&1 | Write-Host
  $LASTEXITCODE -eq 0
}

Write-Host '--- the app'
Check 'it starts bloomd' { StartApp }
Check 'bloomd opens no console window' { (Running | Where-Object Name -EQ 'node').MainWindowHandle -eq 0 }
Start-Sleep -Seconds 20
Write-Host "window: $((Get-Process bloomterm).MainWindowTitle)"
Check 'a screenshot' { Screenshot 'app' }

Write-Host '--- the tray menu, from a script'
& $exe --menu=sources
Start-Sleep -Seconds 3
Check 'a screenshot of Sources' { Screenshot 'sources' }

Write-Host '--- the keyboard'
# WebView2 could keep these for itself. Only the pictures show that the page got them.
Press '^k'
Check 'a screenshot of Ctrl+K' { Screenshot 'ctrl-k' }
Press '{ESC}'
Press '^j'
Check 'a screenshot of Ctrl+J' { Screenshot 'ctrl-j' }
Press '^j'

Write-Host '--- the tray menu, again'
Check 'Open at Login turns on' { & $exe --menu=login; WaitFor 10 { OpensAtLogin } }
Check 'and off' { & $exe --menu=login; WaitFor 10 { -not (OpensAtLogin) } }
Check 'Restart bloomd restarts it' {
  $before = (Bloomd).pid
  & $exe --menu=restart
  WaitFor 30 { (Bloomd).pid -ne $before -and (Healthy) }
}

Write-Host '--- closing the window'
Check 'it shows before' { WindowShows }
Check 'it hides, and bloomd keeps running' {
  (Get-Process bloomterm).CloseMainWindow() | Out-Null
  Start-Sleep -Seconds 2
  Screenshot 'closed' | Out-Null
  (Healthy) -and -not (WindowShows)
}
Check 'opening the app again shows it' { Start-Process $exe; WaitFor 10 { WindowShows } }

Write-Host '--- quitting'
Check 'Quit stops the app and bloomd' { & $exe --menu=quit; Stopped }
Check 'bloomd stopped by itself' { (Stops) -gt 0 }

Write-Host '--- installing over the running app'
Check 'it starts again' { StartApp }
Check 'the installer finishes' { Install }
Check 'nothing of the old one is left running' { Stopped }
Check 'the new one runs' { & $node --version; $LASTEXITCODE -eq 0 }
Running | Stop-Process -Force

if ($Update) {
  Write-Host '--- updating'
  $requests = Join-Path $Out 'updates.log'
  $server = Start-Process python -ArgumentList '-m', 'http.server', '8765', '--bind', '127.0.0.1', '--directory', $Update -RedirectStandardError $requests -WindowStyle Hidden -PassThru
  Check 'it starts again' { StartApp }
  Check 'it downloads the update by itself' { WaitFor 90 { Select-String -Quiet -Path $requests -Pattern 'GET /bloomterm-setup.exe' } }
  Start-Sleep -Seconds 3
  Check 'a screenshot of the toast' { Screenshot 'update-ready' }
  Check 'the toast reaches the notification center' {
    $history = "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; [Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory('app.bloomterm.desktop').Count"
    [int] (powershell.exe -NoProfile -Command $history) -gt 0
  }
  Start-Sleep -Seconds 3
  $stops = Stops
  & $exe --menu=update
  Check 'bloomd stops by itself first' { WaitFor 30 { (Stops) -gt $stops } }
  Check 'the app comes back as the new version' { WaitFor 120 { (Version) -eq '99.0.0' -and (Running) -and (Healthy) } }
  $server | Stop-Process
}

if ($Update) {
  Write-Host '--- Setup, with the real agents'
  $claude = Join-Path $env:USERPROFILE '.local\bin\claude.exe'
  $codex = Join-Path $env:LOCALAPPDATA 'Programs\OpenAI\Codex\bin\codex.exe'
  $setup = Api GET /api/setup
  Check 'there is no agent yet' { -not $setup.agent.found }
  Check 'Claude Code installs as Setup says' { (Paste $setup.agent.install.claude) -and (Test-Path $claude) }
  Check 'Check again restarts bloomd to use it' {
    $before = (Bloomd).pid
    (Api POST /api/setup/check).restarting -and (WaitFor 60 { (Bloomd).pid -ne $before -and (Healthy) })
  }
  $setup = Api GET /api/setup
  Write-Host "in use: $($setup.agent.inUse.kind) $($setup.agent.inUse.version), signed in: $($setup.agent.signedIn)"
  Write-Host "new windows find it: $([Environment]::GetEnvironmentVariable('Path', 'User') -like '*\.local\bin*')"
  Check 'bloomd uses it, and sees it signed out' { $setup.agent.inUse.kind -eq 'claude' -and $setup.agent.signedIn -eq $false }
  Check 'the sign-in command Setup gives runs' { Paste "$($setup.agent.signIn) --help" }
  Check 'Codex installs as Setup says' { (Paste $setup.agent.install.codex) -and (Test-Path $codex) }
  Check 'Check again finds it too' { (Api POST /api/setup/check).agent.installed.kind -contains 'codex' }
  Check 'its sign-in command runs' { Paste "& `"$codex`" login --help" }
  Check 'the README''s way to check the installer runs' { Paste "Get-FileHash '$Installer'" }
}

Write-Host '--- uninstalling the running app'
Check 'it starts again' { StartApp }
Start-Process (Join-Path $app 'uninstall.exe') -ArgumentList '/S' -Wait
Check 'the app goes' { WaitFor 30 { -not (Test-Path $exe) } }
Check 'its folder goes' { WaitFor 30 { -not (Test-Path $app) } }
Check 'nothing is left running' { Stopped }
Check 'your data stays' { Test-Path (Join-Path $data 'state') }

Copy-Item -Recurse (Join-Path $data 'logs') $Out -ErrorAction SilentlyContinue
Write-Host "--- $script:failures failed"
exit [int] ($script:failures -gt 0)
