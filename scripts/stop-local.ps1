$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $root ".research-tree.pid"
$healthUrl = "http://127.0.0.1:4318/api/health"

try {
  $isResearchTree = $false
  try {
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1
    $isResearchTree = $health.service -eq "research-tree-studio"
  } catch {}

  if (Test-Path -LiteralPath $pidFile) {
    $serverPid = [int](Get-Content -LiteralPath $pidFile -Raw)
    Stop-Process -Id $serverPid -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  } elseif ($isResearchTree) {
    $connection = Get-NetTCPConnection -LocalPort 4318 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($connection) {
      Stop-Process -Id $connection.OwningProcess -Force -ErrorAction Stop
    }
  }

  Write-Host "研究树本地服务已停止。" -ForegroundColor Green
  exit 0
} catch {
  Write-Host "停止服务失败：$($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
