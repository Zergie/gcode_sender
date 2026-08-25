<#[
  Packages the application through Electron Forge and smoke-tests the resulting
  unpacked Windows application and configured installer output.
]#>
param(
  [int]$StartupTimeoutSeconds = 30,
  [switch]$KeepArtifacts
)

$ErrorActionPreference = 'Stop'

if ($env:OS -ne 'Windows_NT') {
  throw 'This packaging verification is Windows-only.'
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$outRoot = Join-Path $repoRoot 'out'
$artifactRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('gcode-sender-package-check-' + [guid]::NewGuid().ToString('N'))
$userDataPath = Join-Path $artifactRoot 'user-data'
$packageLog = Join-Path $artifactRoot 'package.log'
$makeLog = Join-Path $artifactRoot 'make.log'
$npmPath = (Get-Command npm -ErrorAction Stop).Source

New-Item -ItemType Directory -Path $artifactRoot, $userDataPath | Out-Null

function Invoke-Npm {
  param(
    [string[]]$Arguments,
    [string]$LogPath
  )

  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & $npmPath @Arguments *> $LogPath
  $exitCode = $LASTEXITCODE
  $ErrorActionPreference = $previousErrorActionPreference
  Get-Content -LiteralPath $LogPath
  if ($exitCode -ne 0) {
    throw "npm $($Arguments -join ' ') failed with exit code $exitCode. See $LogPath"
  }
}

function Find-PackagedApplication {
  $candidates = @(
    Get-ChildItem -LiteralPath $outRoot -Directory -Filter '*-win32-*' -ErrorAction SilentlyContinue |
      ForEach-Object { Get-ChildItem -LiteralPath $_.FullName -File -Filter '*.exe' -ErrorAction SilentlyContinue }
  )

  if ($candidates.Count -ne 1) {
    $paths = ($candidates | ForEach-Object FullName) -join ', '
    throw "Expected exactly one unpacked Windows application executable under out, found $($candidates.Count): $paths"
  }
  return $candidates[0]
}

function Stop-LaunchedProcess {
  param([System.Diagnostics.Process]$Process)
  if ($null -eq $Process) { return }
  try {
    if (-not $Process.HasExited) {
      Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
    }
  } catch {
    # The process may already have exited during cleanup.
  }
}

$appProcess = $null
try {
  Invoke-Npm -Arguments @('run', 'package') -LogPath $packageLog
  Invoke-Npm -Arguments @('run', 'make') -LogPath $makeLog

  $application = Find-PackagedApplication
  $applicationRoot = $application.Directory.FullName
  $resourcesRoot = Join-Path $applicationRoot 'resources'
  $asarPath = Join-Path $resourcesRoot 'app.asar'
  $firmwareRoot = Join-Path $resourcesRoot 'firmware-wasm'
  $nativeRoot = Join-Path $resourcesRoot 'app.asar.unpacked'

  foreach ($requiredPath in @($asarPath, $firmwareRoot, $nativeRoot)) {
    if (-not (Test-Path -LiteralPath $requiredPath)) {
      throw "Packaged application is missing required resource: $requiredPath"
    }
  }
  if (-not (Get-ChildItem -LiteralPath $firmwareRoot -File -Recurse -ErrorAction SilentlyContinue)) {
    throw "Packaged firmware resource directory is empty: $firmwareRoot"
  }
  if (-not (Get-ChildItem -LiteralPath $nativeRoot -File -Recurse -Filter '*.node' -ErrorAction SilentlyContinue)) {
    throw "Packaged application contains no unpacked native serial module under: $nativeRoot"
  }

  $appProcess = Start-Process -FilePath $application.FullName -ArgumentList @(
    "--user-data-dir=$userDataPath",
    '--disable-gpu'
  ) -WorkingDirectory $applicationRoot -PassThru

  $deadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
  do {
    Start-Sleep -Milliseconds 250
    $appProcess.Refresh()
    if ($appProcess.HasExited) {
      throw "Packaged application exited during smoke check with code $($appProcess.ExitCode)."
    }
  } while ([DateTime]::UtcNow -lt $deadline)

  Write-Output "PASS: packaged application launched: $($application.FullName)"
  Write-Output "PASS: app.asar, firmware resources, and unpacked native modules are present."
  Write-Output "PASS: configured installer output was produced under $outRoot."
} finally {
  Stop-LaunchedProcess -Process $appProcess
  if (-not $KeepArtifacts) {
    Remove-Item -LiteralPath $artifactRoot -Recurse -Force -ErrorAction SilentlyContinue
  } else {
    Write-Output "Diagnostics retained at $artifactRoot"
  }
}
