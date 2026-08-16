<#
  Launches the development Electron runtime with an isolated profile and verifies
  the native HWND icon is the branded application icon, not Electron's default.
]#>
param(
  [string]$ExpectedIcon = "images/icon.ico",
  [int]$TimeoutSeconds = 45,
  [switch]$KeepArtifacts
)

$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
  throw "This runtime check is Windows-only."
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$expectedPath = (Resolve-Path (Join-Path $repoRoot $ExpectedIcon)).Path
$electronPath = (Resolve-Path (Join-Path $repoRoot "node_modules/electron/dist/electron.exe")).Path
$nodePath = (Get-Command node -ErrorAction Stop).Source
$angularCliPath = (Resolve-Path (Join-Path $repoRoot "node_modules/@angular/cli/bin/ng.js")).Path
$artifactRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("gcode-sender-icon-check-" + [guid]::NewGuid().ToString("N"))
$userDataPath = Join-Path $artifactRoot "user-data"
$rendererLog = Join-Path $artifactRoot "renderer.log"
$rendererErrorLog = Join-Path $artifactRoot "renderer-error.log"
$electronLog = Join-Path $artifactRoot "electron.log"
$electronErrorLog = Join-Path $artifactRoot "electron-error.log"
$portProbe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$portProbe.Start()
$rendererPort = ([System.Net.IPEndPoint]$portProbe.LocalEndpoint).Port
$portProbe.Stop()
$rendererUrl = "http://127.0.0.1:$rendererPort"

New-Item -ItemType Directory -Path $artifactRoot, $userDataPath | Out-Null

try {
  Add-Type -AssemblyName System.Drawing.Common
} catch {
  Add-Type -AssemblyName System.Drawing
}
Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class WindowIconProbe
{
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", EntryPoint = "GetClassLongPtrW")]
    private static extern IntPtr GetClassLongPtr64(IntPtr hWnd, int index);

    [DllImport("user32.dll", EntryPoint = "GetClassLongW")]
    private static extern uint GetClassLong32(IntPtr hWnd, int index);

    public static IntPtr GetClassIcon(IntPtr hWnd, int index)
    {
        return IntPtr.Size == 8 ? GetClassLongPtr64(hWnd, index) : new IntPtr(GetClassLong32(hWnd, index));
    }
}
"@

function Get-IconBitmap {
  param([System.Drawing.Icon]$Icon)

  $result = [System.Drawing.Bitmap]::new(32, 32, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($result)
  try {
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $graphics.DrawIcon($Icon, [System.Drawing.Rectangle]::new(0, 0, 32, 32))
  } finally {
    $graphics.Dispose()
  }
  return $result
}

function Get-PixelDistance {
  param(
    [System.Drawing.Bitmap]$Left,
    [System.Drawing.Bitmap]$Right
  )

  [double]$sum = 0
  for ($y = 0; $y -lt 32; $y++) {
    for ($x = 0; $x -lt 32; $x++) {
      $a = $Left.GetPixel($x, $y)
      $b = $Right.GetPixel($x, $y)
      $sum += [Math]::Abs($a.A - $b.A)
      $sum += [Math]::Abs($a.R - $b.R)
      $sum += [Math]::Abs($a.G - $b.G)
      $sum += [Math]::Abs($a.B - $b.B)
    }
  }
  return $sum / (32 * 32 * 4 * 255)
}

function Get-WindowIconHandle {
  param([IntPtr]$WindowHandle)

  $wmGetIcon = 0x007F
  foreach ($iconType in 1, 0, 2) {
    $handle = [WindowIconProbe]::SendMessage($WindowHandle, $wmGetIcon, [IntPtr]$iconType, [IntPtr]::Zero)
    if ($handle -ne [IntPtr]::Zero) {
      return $handle
    }
  }

  foreach ($classIndex in -14, -34) {
    $handle = [WindowIconProbe]::GetClassIcon($WindowHandle, $classIndex)
    if ($handle -ne [IntPtr]::Zero) {
      return $handle
    }
  }

  return [IntPtr]::Zero
}

function Stop-LaunchedProcess {
  param([System.Diagnostics.Process]$LaunchedProcess)

  try {
    $current = Get-Process -Id $LaunchedProcess.Id -ErrorAction Stop
    if ($current.StartTime -eq $LaunchedProcess.StartTime) {
      Stop-Process -Id $current.Id -Force -ErrorAction SilentlyContinue
    }
  } catch {
    # The launched process has already exited; never act on a recycled PID.
  }
}

function Stop-ProcessesWithCommandLineMarkers {
  param([string[]]$Markers)

  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $commandLine = $_.CommandLine
      if (-not $commandLine) { return $false }
      foreach ($marker in $Markers) {
        if (-not $commandLine.Contains($marker)) { return $false }
      }
      return $true
    } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

$rendererProcess = $null
$electronProcess = $null
$previousRendererUrl = $env:ELECTRON_RENDERER_URL

try {
  $rendererProcess = Start-Process -FilePath $nodePath -ArgumentList @(
    $angularCliPath,
    "serve",
    "--host", "127.0.0.1",
    "--port", $rendererPort
  ) -WorkingDirectory $repoRoot -RedirectStandardOutput $rendererLog -RedirectStandardError $rendererErrorLog -PassThru -WindowStyle Hidden

  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    try {
      $response = Invoke-WebRequest -Uri $rendererUrl -UseBasicParsing -TimeoutSec 1
      if ($response.StatusCode -eq 200) { break }
    } catch {
      Start-Sleep -Milliseconds 250
    }
  } while ([DateTime]::UtcNow -lt $deadline)

  if (-not $response -or $response.StatusCode -ne 200) {
    throw "Renderer did not become ready. See $rendererLog"
  }
  if ($rendererProcess.HasExited) {
    throw "The isolated Angular renderer exited before verification. See $rendererErrorLog"
  }

  $env:ELECTRON_RENDERER_URL = $rendererUrl
  # The application window must be visible so Windows registers the same HWND/taskbar
  # icon used during `npm run start`; only the renderer helper is background-hidden.
  $electronProcess = Start-Process -FilePath $electronPath -ArgumentList @(
    ".",
    "--user-data-dir=$userDataPath"
  ) -WorkingDirectory $repoRoot -RedirectStandardOutput $electronLog -RedirectStandardError $electronErrorLog -PassThru

  $windowProcess = $null
  do {
    $windowProcess = Get-Process -Id $electronProcess.Id -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne 0 }

    if (-not $windowProcess) {
      $ownedProcessIds = Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -and $_.CommandLine.Contains($userDataPath) } |
        Select-Object -ExpandProperty ProcessId
      $windowProcess = $ownedProcessIds |
        ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue } |
        Where-Object { $_.MainWindowHandle -ne 0 } |
        Select-Object -First 1
    }

    if ($windowProcess) { break }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)

  if (-not $windowProcess) {
    throw "GCode Sender window did not appear. See $electronLog"
  }

  $actualHandle = Get-WindowIconHandle -WindowHandle $windowProcess.MainWindowHandle
  if ($actualHandle -eq [IntPtr]::Zero) {
    throw "The GCode Sender window has no WM_GETICON or registered class icon."
  }

  $actualIcon = [System.Drawing.Icon]::FromHandle($actualHandle)
  $expectedIconObject = [System.Drawing.Icon]::new($expectedPath, 32, 32)
  $defaultIconObject = [System.Drawing.Icon]::ExtractAssociatedIcon($electronPath)
  $actualBitmap = Get-IconBitmap -Icon $actualIcon
  $expectedBitmap = Get-IconBitmap -Icon $expectedIconObject
  $defaultBitmap = Get-IconBitmap -Icon $defaultIconObject
  try {
    $actualPath = Join-Path $artifactRoot "actual-window-icon.png"
    $actualBitmap.Save($actualPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $expectedDistance = Get-PixelDistance -Left $actualBitmap -Right $expectedBitmap
    $electronDistance = Get-PixelDistance -Left $actualBitmap -Right $defaultBitmap

    Write-Output ("Window PID: {0}" -f $windowProcess.Id)
    Write-Output ("Desired icon distance: {0:N6}" -f $expectedDistance)
    Write-Output ("Electron icon distance: {0:N6}" -f $electronDistance)
    Write-Output ("Captured icon: {0}" -f $actualPath)

    if ($expectedDistance -ge $electronDistance) {
      throw "FAIL: the development window is using Electron's icon instead of images/icon.ico."
    }

    Write-Output "PASS: the development window icon matches images/icon.ico more closely than Electron's default icon."
  } finally {
    $actualBitmap.Dispose()
    $expectedBitmap.Dispose()
    $defaultBitmap.Dispose()
    $expectedIconObject.Dispose()
    $defaultIconObject.Dispose()
  }
} finally {
  if ($null -eq $previousRendererUrl) {
    Remove-Item Env:ELECTRON_RENDERER_URL -ErrorAction SilentlyContinue
  } else {
    $env:ELECTRON_RENDERER_URL = $previousRendererUrl
  }

  if ($electronProcess) {
    Stop-LaunchedProcess -LaunchedProcess $electronProcess
  }
  if ($rendererProcess) {
    Stop-LaunchedProcess -LaunchedProcess $rendererProcess
  }
  Stop-ProcessesWithCommandLineMarkers -Markers @($userDataPath)
  Stop-ProcessesWithCommandLineMarkers -Markers @($angularCliPath, "--port $rendererPort")

  if (-not $KeepArtifacts) {
    $cleanupDeadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
      try {
        Remove-Item -LiteralPath $artifactRoot -Recurse -Force -ErrorAction Stop
        break
      } catch {
        if ([DateTime]::UtcNow -ge $cleanupDeadline) {
          throw "Could not remove isolated icon-check artifacts at $artifactRoot"
        }
        Start-Sleep -Milliseconds 100
      }
    } while ($true)
  }
}
