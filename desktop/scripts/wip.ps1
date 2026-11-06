# Pitchroom WIP: the desktop app as this repo has it right now (unreleased work and uncommitted edits too), made into a
# folder of its own (no installer) and put in %LOCALAPPDATA%\Programs\Pitchroom WIP, with "Pitchroom WIP" on the
# desktop and in the Start menu. An app apart: another name and id, so its own folder for the library, the song tools
# and the settings (%APPDATA%\Pitchroom WIP, empty the first time: onboarding, the tools' download), its own lock, and
# no updates (main.js: package.json's "wip"). It doesn't change until this is run again: edits in the repo meanwhile
# don't reach it. Windows only.
#   powershell -ExecutionPolicy Bypass -File desktop\scripts\wip.ps1
$ErrorActionPreference = "Stop"
$desktop = Split-Path -Parent $PSScriptRoot
$repo = Split-Path -Parent $desktop
$target = Join-Path $env:LOCALAPPDATA "Programs\Pitchroom WIP"
$exe = Join-Path $target "Pitchroom WIP.exe"

# not over itself while it runs (its engine would go with it, a song half added)
if (Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }) { throw "Pitchroom WIP is open: close it first." }

Push-Location $desktop
try {
  if (-not (Test-Path "node_modules\electron\dist\electron.exe")) { npm ci --no-audit --no-fund; node node_modules/electron/install.js }
  if (-not (Test-Path "runtime\python.exe")) { node scripts/fetch-python.mjs; if ($LASTEXITCODE) { throw "fetch-python failed" } } # the app's own Python, once
  if (-not (Test-Path "vbcable\VBCABLE_Setup_x64.exe")) { node scripts/fetch-vbcable.mjs; if ($LASTEXITCODE) { throw "fetch-vbcable failed" } } # Live's mic, once
  node scripts/prepare-code.mjs; if ($LASTEXITCODE) { throw "prepare-code failed" } # the code as it is now
  # which it's made from: the commit, + if there were edits not committed yet
  $stamp = (git -C $repo rev-parse --short HEAD).Trim()
  if (git -C $repo status --porcelain --untracked-files=no) { $stamp += "+" }
  npx electron-builder --win --x64 --dir --publish never `
    "--config.productName=Pitchroom WIP" "--config.appId=com.freaktion.pitchroom.wip" "--config.directories.output=dist-wip" `
    "--config.extraMetadata.productName=Pitchroom WIP" "--config.extraMetadata.wip=$stamp"
  if ($LASTEXITCODE) { throw "electron-builder failed" }
} finally { Pop-Location }

# into its place (what's there replaced; what's yours is in %APPDATA%, untouched)
robocopy (Join-Path $desktop "dist-wip\win-unpacked") $target /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copying into $target failed ($LASTEXITCODE)." }
$global:LASTEXITCODE = 0

$shell = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath("Desktop"), [Environment]::GetFolderPath("Programs"))) {
  $lnk = $shell.CreateShortcut((Join-Path $dir "Pitchroom WIP.lnk"))
  $lnk.TargetPath = $exe; $lnk.Arguments = ""; $lnk.WorkingDirectory = $target; $lnk.IconLocation = "$exe,0"
  $lnk.Description = "Pitchroom, not released yet ($stamp)"
  $lnk.Save()
}
"Pitchroom WIP $stamp in $target"
