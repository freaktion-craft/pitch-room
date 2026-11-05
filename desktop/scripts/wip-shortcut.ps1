# "Pitchroom WIP" on the desktop and in the Start menu: the app run from this repo (main.js --wip), on the copy
# launch.py runs (localhost 5178 on, the repo's library), so what isn't released yet can be tried in a window, nothing
# built. Needs `npm ci` in desktop/ once (Electron). Run again any time: the shortcuts are made afresh.
#   powershell -ExecutionPolicy Bypass -File desktop\scripts\wip-shortcut.ps1
$ErrorActionPreference = "Stop"
$desktop = Split-Path -Parent $PSScriptRoot
$repo = Split-Path -Parent $desktop
$electron = Join-Path $desktop "node_modules\electron\dist\electron.exe"
if (-not (Test-Path $electron)) { throw "No Electron at $electron. Run 'npm ci' in $desktop first." }

# its icon: the app's, as a .ico (a shortcut takes no .png), kept in the WIP's own folder
$data = Join-Path $env:APPDATA "Pitchroom WIP"
New-Item -ItemType Directory -Force $data | Out-Null
$ico = Join-Path $data "icon.ico"
$py = Join-Path $repo ".venv\Scripts\python.exe"
& $py -I -c "import sys; from PIL import Image; Image.open(sys.argv[1]).save(sys.argv[2], sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])" (Join-Path $desktop "build\icon-win.png") $ico

$shell = New-Object -ComObject WScript.Shell
$places = @([Environment]::GetFolderPath("Desktop"), (Join-Path ([Environment]::GetFolderPath("Programs")) ""))
foreach ($dir in $places) {
  $lnk = $shell.CreateShortcut((Join-Path $dir "Pitchroom WIP.lnk"))
  $lnk.TargetPath = $electron
  $lnk.Arguments = "`"$desktop`" --wip"
  $lnk.WorkingDirectory = $desktop
  $lnk.IconLocation = "$ico,0"
  $lnk.Description = "Pitchroom, as it is in $repo (not released yet)"
  $lnk.Save()
  "made $($lnk.FullName)"
}
