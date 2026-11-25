# Creates a desktop shortcut that opens XC Organiser in its own window.
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$app = Join-Path $here 'XC-Organiser.html'
$url = 'file:///' + (($app -replace '\\', '/') -replace ' ', '%20')
$profileDir = Join-Path $env:LOCALAPPDATA 'XCMeetManager\BrowserProfile'
$candidates = @(
  (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe'),
  (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
  (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
)
$exe = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
$shell = New-Object -ComObject WScript.Shell
$lnkPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'XC Organiser.lnk'
$lnk = $shell.CreateShortcut($lnkPath)
if ($exe) {
  $lnk.TargetPath = $exe
  $lnk.Arguments = "--app=`"$url`" --user-data-dir=`"$profileDir`" --no-first-run --no-default-browser-check --window-size=1400,900"
  $lnk.IconLocation = "$exe,0"
} else {
  $lnk.TargetPath = $app
}
$lnk.WorkingDirectory = $here
$lnk.Description = 'XC Organiser'
$lnk.Save()
Write-Host "Shortcut created: $lnkPath"
