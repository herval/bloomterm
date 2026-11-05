# Installs bloomterm from its installer and uses it, as someone would on their own PC. GitHub's
# Windows machine is the only one this runs on, so every check runs even after one fails, and a
# screenshot and the logs go to the results folder.
#
#   pwsh scripts/windows-smoke.ps1 <installer.exe> <results folder>

param(
  [Parameter(Mandatory)] [string] $Installer,
  [Parameter(Mandatory)] [string] $Out
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

function Healthy {
  $port = (Get-Content -Raw (Join-Path $data 'state\bloomd.json') | ConvertFrom-Json).port
  (Invoke-RestMethod -TimeoutSec 3 "http://127.0.0.1:$port/api/health").name -eq 'bloomd'
}

function StartApp {
  Start-Process $exe
  WaitFor 90 { Healthy }
}

function Stopped { WaitFor 20 { -not (Running) } }

function Install { (Start-Process $Installer -ArgumentList '/S' -Wait -PassThru).ExitCode -eq 0 }

function Screenshot([string] $name) {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $image = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  [System.Drawing.Graphics]::FromImage($image).CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
  $image.Save((Join-Path $Out "$name.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  $true
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

Write-Host '--- quitting'
Check '--quit stops the app and bloomd' { & $exe --quit; Stopped }
Check 'bloomd stopped by itself' { Select-String -Quiet -Path $log -Pattern 'stopping.*shutdown' }

Write-Host '--- installing over the running app'
Check 'it starts again' { StartApp }
Check 'the installer finishes' { Install }
Check 'nothing of the old one is left running' { Stopped }
Check 'the new one runs' { & $node --version; $LASTEXITCODE -eq 0 }
Running | Stop-Process -Force

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
