param(
    [switch]$Rebuild,
    [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$FrontendDir = Join-Path $ProjectRoot 'CrescoAI-Frontend'
$BackendDir = Join-Path $ProjectRoot 'CrescoAI-Backend\backend'
$RuntimeDir = Join-Path $ProjectRoot '.runtime'
$DataDir = Join-Path $ProjectRoot 'data'
$PidFile = Join-Path $RuntimeDir 'processes.json'

function Stop-CareerAgent {
    if (-not (Test-Path $PidFile)) {
        Write-Host 'Career Agent is not running (no PID file found).'
        return
    }

    $Processes = Get-Content $PidFile -Raw | ConvertFrom-Json
    foreach ($ProcessId in @($Processes.frontend, $Processes.backend)) {
        if ($ProcessId) {
            & taskkill.exe /PID $ProcessId /T /F 2>$null | Out-Null
        }
    }
    Remove-Item $PidFile -Force
    Write-Host 'Career Agent stopped.'
}

if ($Stop) {
    Stop-CareerAgent
    exit 0
}

if (Test-Path $PidFile) {
    $Existing = Get-Content $PidFile -Raw | ConvertFrom-Json
    $Alive = @($Existing.frontend, $Existing.backend) | Where-Object {
        Get-Process -Id $_ -ErrorAction SilentlyContinue
    }
    if ($Alive.Count -gt 0) {
        Write-Host 'Career Agent is already running at http://127.0.0.1:8080'
        exit 0
    }
    Remove-Item $PidFile -Force
}

$BunCommand = Get-Command bun -ErrorAction SilentlyContinue
if (-not $BunCommand) {
    $WinGetBun = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links\bun.exe'
    if (Test-Path $WinGetBun) {
        $BunExe = $WinGetBun
    } else {
        throw 'Bun is not installed. Install it with: winget install --id Oven-sh.Bun'
    }
} else {
    $BunExe = $BunCommand.Source
}

New-Item -ItemType Directory -Force -Path $RuntimeDir, $DataDir | Out-Null

if ($Rebuild -or -not (Test-Path (Join-Path $BackendDir 'node_modules'))) {
    Write-Host '[1/4] Installing backend dependencies...'
    & $BunExe install --cwd $BackendDir --production
    if ($LASTEXITCODE -ne 0) { throw 'Backend dependency installation failed.' }
}

if ($Rebuild -or -not (Test-Path (Join-Path $FrontendDir 'node_modules'))) {
    Write-Host '[2/4] Installing frontend dependencies...'
    Push-Location $FrontendDir
    try { npm ci } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0) { throw 'Frontend dependency installation failed.' }
}

Write-Host '[3/4] Migrating database and building frontend...'
$env:CAREER_AGENT_DATABASE_PATH = Join-Path $DataDir 'career-agent.sqlite'
$env:CAREER_AGENT_SKIP_AUTH = 'false'
$env:CAREER_AGENT_SKIP_AUTH_USER_ID = '1'
$env:CAREER_AGENT_EXTERNAL_SKILL_DIRS = Join-Path $ProjectRoot 'skills'
& $BunExe run --cwd $BackendDir network:migrate
if ($LASTEXITCODE -ne 0) { throw 'Database migration failed.' }

$env:VITE_CAREER_AGENT_CLIENT_MODE = 'upstream'
$env:VITE_CAREER_AGENT_API_BASE_URL = '/'
$env:VITE_CAREER_AGENT_USER_ID = '1'
$env:VITE_CAREER_AGENT_WITH_CREDENTIALS = 'false'
$env:VITE_CAREER_AGENT_SKIP_AUTH = 'true'
Push-Location $FrontendDir
try { npm run build } finally { Pop-Location }
if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }

Write-Host '[4/4] Starting services...'
$BackendOut = Join-Path $RuntimeDir 'backend.log'
$BackendErr = Join-Path $RuntimeDir 'backend-error.log'
$FrontendOut = Join-Path $RuntimeDir 'frontend.log'
$FrontendErr = Join-Path $RuntimeDir 'frontend-error.log'

$BackendProcess = Start-Process -FilePath $BunExe -ArgumentList 'run','network:start' -WorkingDirectory $BackendDir -WindowStyle Hidden -PassThru -RedirectStandardOutput $BackendOut -RedirectStandardError $BackendErr
$FrontendProcess = Start-Process -FilePath 'npm.cmd' -ArgumentList 'run','preview','--','--host','127.0.0.1','--port','8080' -WorkingDirectory $FrontendDir -WindowStyle Hidden -PassThru -RedirectStandardOutput $FrontendOut -RedirectStandardError $FrontendErr

@{
    backend = $BackendProcess.Id
    frontend = $FrontendProcess.Id
} | ConvertTo-Json | Set-Content $PidFile -Encoding utf8

$Ready = $false
for ($Attempt = 1; $Attempt -le 30; $Attempt++) {
    try {
        $null = Invoke-WebRequest 'http://127.0.0.1:4000/' -UseBasicParsing -TimeoutSec 3
        $null = Invoke-WebRequest 'http://127.0.0.1:8080/api/career-agent/threads' -UseBasicParsing -TimeoutSec 3
        $Ready = $true
        break
    } catch {
        Start-Sleep -Seconds 2
    }
}

if (-not $Ready) {
    Write-Warning 'Service health check did not pass within 60 seconds.'
    Write-Warning "Inspect logs in $RuntimeDir"
    exit 1
}

Write-Host ''
Write-Host 'Career Agent is running: http://127.0.0.1:8080'
Write-Host 'Stop it with: .\start-lite.ps1 -Stop'
