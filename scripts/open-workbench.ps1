param([switch]$Bootcamp, [switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$homeDir = if ($env:AGENT_AUTOLOOP_HOME) { $env:AGENT_AUTOLOOP_HOME } else { Join-Path $env:USERPROFILE '.agent-autoloop' }
$port = if ($env:AUTOLOOP_WORKBENCH_PORT) { [int]$env:AUTOLOOP_WORKBENCH_PORT } else { 3351 }
$base = "http://127.0.0.1:$port"
$sessionFile = Join-Path $homeDir 'workbench-session.txt'
$repo = Split-Path -Parent $PSScriptRoot

function Get-WorkbenchSession {
    if (-not (Test-Path -LiteralPath $sessionFile)) { return }
    $saved = [IO.File]::ReadAllText($sessionFile)
    if ($saved -notmatch ('^' + [regex]::Escape($base) + '/#/\?session=([A-Za-z0-9_-]{43})$')) { return }
    try {
        $reply = Invoke-RestMethod -UseBasicParsing -Uri "$base/local/session" -TimeoutSec 1 -Headers @{ Authorization = 'Bearer ' + $Matches[1] }
        if ($reply.ok) {
            if ($Bootcamp -and -not $reply.bootcamp) {
                Write-Warning '当前工作台会话没有开启实训营入口。关闭现有工作台进程后，使用 -Bootcamp 重新打开。'
            }
            return $saved
        }
    } catch {
        return
    }
}

if (-not (Test-Path -LiteralPath (Join-Path $homeDir 'config.json') -PathType Leaf)) {
    throw '未找到本机 Autoloop 配置。请先启动中台，或检查 AGENT_AUTOLOOP_HOME。'
}
$sessionUrl = Get-WorkbenchSession
if (-not $sessionUrl) {
    $node = (Get-Command node.exe).Source
    $arguments = @('scripts/workbench.ts', '--session-file')
    if ($Bootcamp) { $arguments += '--bootcamp' }
    $process = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $repo -WindowStyle Hidden -PassThru
    for ($attempt = 0; $attempt -lt 24; $attempt++) {
        Start-Sleep -Milliseconds 250
        $sessionUrl = Get-WorkbenchSession
        if ($sessionUrl -or $process.HasExited) { break }
    }
}
if (-not $sessionUrl) { throw "工作台无法启动。请检查本机 $port 端口或中台配置。" }
if (-not $NoBrowser) { Start-Process $sessionUrl }
Write-Output $base
