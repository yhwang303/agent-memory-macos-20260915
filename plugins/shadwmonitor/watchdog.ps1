# AI Monitor 守护进程脚本
# 自动监控并重启 capture 和 web 服务

$ErrorActionPreference = "SilentlyContinue"
$WorkDir = $PSScriptRoot

# 加载 .env 文件
$envFile = Join-Path $WorkDir ".env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match "^\s*([^#][^=]+)=(.*)$") {
            [System.Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim(), "Process")
        }
    }
    Write-Host "[OK] .env 配置已加载" -ForegroundColor Green
} else {
    Write-Host "[WARN] 未找到 .env 文件" -ForegroundColor Yellow
}

$captureJob = $null
$webJob     = $null

function Get-ServicePid($keyword) {
    Get-WmiObject Win32_Process | Where-Object {
        $_.CommandLine -and $_.CommandLine -match $keyword
    } | Select-Object -ExpandProperty ProcessId -First 1
}

function Start-Capture {
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] 启动采集服务..." -ForegroundColor Cyan
    $env:AI_MONITOR_BASE_URL = [System.Environment]::GetEnvironmentVariable("AI_MONITOR_BASE_URL", "Process")
    $env:AI_MONITOR_API_KEY  = [System.Environment]::GetEnvironmentVariable("AI_MONITOR_API_KEY",  "Process")
    Start-Process "python" -ArgumentList "src/main.py capture" -WorkingDirectory $WorkDir -PassThru
}

function Start-Web {
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] 启动 Web 服务..." -ForegroundColor Cyan
    Start-Process "python" -ArgumentList "src/main.py web" -WorkingDirectory $WorkDir -PassThru
}

# 停止现有进程
Write-Host "`n[INFO] 停止旧进程..." -ForegroundColor Yellow
Get-Process python -ErrorAction SilentlyContinue | ForEach-Object {
    $cmd = (Get-WmiObject Win32_Process -Filter "ProcessId=$($_.Id)").CommandLine
    if ($cmd -match "main\.py") {
        Stop-Process -Id $_.Id -Force
        Write-Host "  已停止 PID $($_.Id): $cmd" -ForegroundColor Gray
    }
}
Start-Sleep -Seconds 2

$captureProc = Start-Capture
Start-Sleep -Seconds 2
$webProc     = Start-Web

Write-Host ""
Write-Host "================================================" -ForegroundColor Green
Write-Host "  AI Monitor 守护进程已启动" -ForegroundColor Green
Write-Host "  Web 界面: http://127.0.0.1:8080" -ForegroundColor Green
Write-Host "  按 Ctrl+C 停止守护进程" -ForegroundColor Yellow
Write-Host "================================================" -ForegroundColor Green
Write-Host ""

# 守护循环
while ($true) {
    Start-Sleep -Seconds 15

    $capturePid = Get-ServicePid "main\.py capture"
    $webPid     = Get-ServicePid "main\.py web"

    $captureOk = $capturePid -ne $null
    $webOk     = $webPid -ne $null

    $captureStatus = if ($captureOk) { "[运行中 PID:$capturePid]" } else { "[已停止]" }
    $webStatus     = if ($webOk)     { "[运行中 PID:$webPid]"     } else { "[已停止]" }
    $captureColor  = if ($captureOk) { "Green" } else { "Red" }
    $webColor      = if ($webOk)     { "Green" } else { "Red" }

    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] 采集服务: " -NoNewline
    Write-Host $captureStatus -ForegroundColor $captureColor -NoNewline
    Write-Host "  Web服务: " -NoNewline
    Write-Host $webStatus -ForegroundColor $webColor

    if (-not $captureOk) {
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] 采集服务挂了，正在重启..." -ForegroundColor Red
        Start-Capture | Out-Null
    }

    if (-not $webOk) {
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] Web 服务挂了，正在重启..." -ForegroundColor Red
        Start-Web | Out-Null
    }
}
