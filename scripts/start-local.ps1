param(
  [switch]$NoOpen
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$url = "http://127.0.0.1:4318/"
$healthUrl = "${url}api/health"
$pidFile = Join-Path $root ".research-tree.pid"
$stdoutLog = Join-Path $root ".research-tree-server.log"
$stderrLog = Join-Path $root ".research-tree-server-error.log"

function Test-ResearchTreeHealth {
  try {
    $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 1
    return $health.service -eq "research-tree-studio"
  } catch {
    return $false
  }
}

try {
  if (-not (Test-Path -LiteralPath (Join-Path $root "server\index.mjs"))) {
    throw "找不到项目服务文件：$root\server\index.mjs"
  }
  if (-not (Test-Path -LiteralPath (Join-Path $root "node_modules"))) {
    throw "项目依赖不存在，请先在项目目录运行 npm install。"
  }

  if (-not (Test-ResearchTreeHealth)) {
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) {
      throw "没有找到 Node.js。请安装 Node.js，或重新使用电脑版便携包。"
    }

    Remove-Item -LiteralPath $stdoutLog, $stderrLog -Force -ErrorAction SilentlyContinue
    $process = Start-Process -FilePath $node.Source `
      -ArgumentList "server/index.mjs" `
      -WorkingDirectory $root `
      -WindowStyle Hidden `
      -RedirectStandardOutput $stdoutLog `
      -RedirectStandardError $stderrLog `
      -PassThru
    Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ascii

    $ready = $false
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
      Start-Sleep -Milliseconds 250
      if (Test-ResearchTreeHealth) {
        $ready = $true
        break
      }
      if ($process.HasExited) {
        break
      }
    }

    if (-not $ready) {
      $details = ""
      if (Test-Path -LiteralPath $stderrLog) {
        $details = (Get-Content -LiteralPath $stderrLog -Tail 12 -ErrorAction SilentlyContinue) -join [Environment]::NewLine
      }
      throw "服务未能启动。可能是 4318 端口被其他程序占用。`n$details`n日志：$stderrLog"
    }
  }

  if (-not $NoOpen) {
    Start-Process $url
  }
  Write-Host "研究树已启动：$url" -ForegroundColor Green
  exit 0
} catch {
  Write-Host "研究树启动失败" -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Yellow
  exit 1
}
