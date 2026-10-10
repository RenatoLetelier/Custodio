# Stops and removes the Custodio tasks. The uninstaller runs it, also before an update.
# C:\ProgramData\Custodio stays: the database, the settings and the history are there for a later install.
$ErrorActionPreference = 'Continue'
$TaskPath = '\Custodio\'

foreach ($name in 'custodio-service', 'custodio-helper') {
  $task = Get-ScheduledTask -TaskPath $TaskPath -TaskName $name -ErrorAction SilentlyContinue
  if ($task) {
    Stop-ScheduledTask -InputObject $task -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -InputObject $task -Confirm:$false -ErrorAction SilentlyContinue
  }
}

# A process still running from this folder would keep the files locked
Get-CimInstance -ClassName Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($PSScriptRoot, [System.StringComparison]::OrdinalIgnoreCase) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

try {
  $scheduler = New-Object -ComObject Schedule.Service
  $scheduler.Connect()
  $scheduler.GetFolder('\').DeleteFolder('Custodio', 0)
} catch {
  # The folder was already gone or still has other tasks
}

# The sign-in entry the app adds for its tray icon, only if it points to this installation
$installRoot = Split-Path (Split-Path $PSScriptRoot)
$run = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$entry = (Get-ItemProperty -Path $run -Name 'Custodio' -ErrorAction SilentlyContinue).Custodio
if ($entry -and $entry.IndexOf($installRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
  Remove-ItemProperty -Path $run -Name 'Custodio' -ErrorAction SilentlyContinue
}
