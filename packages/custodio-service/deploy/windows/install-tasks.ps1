# Registers custodio-helper (SYSTEM, elevated) and custodio-service (the user who installs, not elevated) as scheduled
# tasks that start with Windows and come back within five minutes if they stop. The installer runs it as administrator.
# It never touches disks or user files: it only creates the data folder, its two secrets and the tasks.
param(
  [Parameter(Mandatory = $true)][string]$ServiceDir
)

$ErrorActionPreference = 'Stop'
$TaskPath = '\Custodio\'
$DataDir = Join-Path $env:ProgramData 'Custodio'
$Node = Join-Path $ServiceDir 'node.exe'
$EnvFile = Join-Path $ServiceDir 'production.env'
$Icacls = Join-Path $env:SystemRoot 'System32\icacls.exe'

# The account signed in at the console, not the elevated one the installer runs as
function Get-InstallingUser {
  $console = (Get-CimInstance -ClassName Win32_ComputerSystem).UserName
  if ($console) { return $console }
  return "$env:USERDOMAIN\$env:USERNAME"
}

function New-SecretFile([string]$Path) {
  if (Test-Path -LiteralPath $Path) { return }
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes)
  $rng.Dispose()
  [System.IO.File]::WriteAllText($Path, (-join ($bytes | ForEach-Object { $_.ToString('x2') })) + "`n")
}

function Invoke-Icacls([string[]]$Arguments) {
  & $Icacls @Arguments | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "icacls $($Arguments -join ' ') failed with code $LASTEXITCODE" }
}

function New-NodeAction([string]$Script) {
  $arguments = '--env-file="{0}" --disable-warning=ExperimentalWarning "{1}"' -f $EnvFile, (Join-Path $ServiceDir $Script)
  New-ScheduledTaskAction -Execute $Node -Argument $arguments -WorkingDirectory $DataDir
}

# The first trigger plus one every five minutes from now; a task that is already running ignores the extra starts
function New-Triggers($First) {
  @($First, (New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)))
}

$user = Get-InstallingUser
$sid = (New-Object System.Security.Principal.NTAccount($user)).Translate([System.Security.Principal.SecurityIdentifier]).Value
Write-Host "Custodio: service account $user ($sid)"

# The service, running as that user, keeps its database and logs here
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
Invoke-Icacls $DataDir, '/grant', "*$($sid):(OI)(CI)M"

# The API token and the helper secret: readable only by SYSTEM, Administrators and that user
foreach ($name in 'service-token', 'helper-secret') {
  $file = Join-Path $DataDir $name
  New-SecretFile $file
  Invoke-Icacls $file, '/inheritance:r', '/grant:r', '*S-1-5-18:F', '*S-1-5-32-544:F', "*$($sid):R"
}

$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskPath $TaskPath -TaskName 'custodio-helper' -Force `
  -Description 'Custodio: lecturas de discos con privilegios, solo operaciones de una lista blanca' `
  -Action (New-NodeAction 'custodio-helper.mjs') `
  -Trigger (New-Triggers (New-ScheduledTaskTrigger -AtStartup)) `
  -Principal (New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest) `
  -Settings $settings | Out-Null

$serviceTask = @{
  TaskPath    = $TaskPath
  TaskName    = 'custodio-service'
  Force       = $true
  Description = 'Custodio: servicio de discos y copias de seguridad, sin privilegios de administrador'
  Action      = New-NodeAction 'custodio-service.mjs'
  Settings    = $settings
}
try {
  # S4U: from boot, with or without a signed-in session, and no password stored
  Register-ScheduledTask @serviceTask -Trigger (New-Triggers (New-ScheduledTaskTrigger -AtStartup)) `
    -Principal (New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited) | Out-Null
} catch {
  Write-Warning "Custodio: the service cannot start with Windows for $user ($($_.Exception.Message)); it will start at sign-in"
  Register-ScheduledTask @serviceTask -Trigger (New-Triggers (New-ScheduledTaskTrigger -AtLogOn -User $user)) `
    -Principal (New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited) | Out-Null
}

Start-ScheduledTask -TaskPath $TaskPath -TaskName 'custodio-helper'
Start-ScheduledTask -TaskPath $TaskPath -TaskName 'custodio-service'
Write-Host 'Custodio: service and helper registered and running'
