# 冒烟「直接双击就能跑的 exe」：RyHarness-portable.exe
# 验三件事：双击后能不能自己起来、接口与安全头在不在、**每次启动要花多久**
# （便携版是自解压的：每次启动都把运行时解到临时目录，这一下启动成本必须量出来）。

$ErrorActionPreference = 'Stop'
$exe = 'F:\AgenticResearch\RyAgent\apps\desktop\ryharness-release\RyHarness-portable.exe'
if (-not (Test-Path $exe)) { throw "找不到 $exe" }

$data = Join-Path $env:TEMP ('ryharness-portable-data-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
New-Item -ItemType Directory -Force -Path $data | Out-Null
$token = 'portable-smoke-token'
$env:CI = 'true'
$env:RYHARNESS_API_TOKEN = $token
$env:RYHARNESS_DATA_DIR = $data
$env:RYHARNESS_PORT = '32100'

$before = @(Get-ChildItem $env:TEMP -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$proc = Start-Process -FilePath $exe -PassThru
try {
  $base = 'http://127.0.0.1:32100'
  $assets = 'http://127.0.0.1:32101'
  $up = $false
  for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      Invoke-WebRequest -Uri "$base/api/agents" -TimeoutSec 3 -UseBasicParsing | Out-Null
      $up = $true
      break
    } catch {
      if ($_.Exception.Response.StatusCode.value__ -eq 401) { $up = $true; break }
    }
  }
  $sw.Stop()
  if (-not $up) { throw '后端 60 秒内没起来' }
  Write-Output "[portable] 从双击到后端可用 = $([math]::Round($sw.Elapsed.TotalSeconds,1)) 秒"

  $page = Invoke-WebRequest -Uri "$assets/app" -TimeoutSec 10 -UseBasicParsing
  Write-Output "[portable] 页面状态 = $($page.StatusCode)"
  Write-Output "[portable] x-frame-options = $($page.Headers['x-frame-options'])"
  Write-Output "[portable] content-security-policy = $($page.Headers['content-security-policy'])"
  try {
    Invoke-WebRequest -Uri "$base/api/agents" -TimeoutSec 10 -UseBasicParsing | Out-Null
    Write-Output '[portable] !! 无 token 竟然调通了（这是洞）'
  } catch {
    Write-Output "[portable] 无 token 调 API = $($_.Exception.Response.StatusCode.value__)"
  }
  $auth = @{ Authorization = "Bearer $token" }
  $vibe = Invoke-WebRequest -Uri "$base/api/vibe" -TimeoutSec 10 -UseBasicParsing -Headers $auth
  Write-Output "[portable] GET /api/vibe = $($vibe.StatusCode) $($vibe.Content)"
  $html = Invoke-WebRequest -Uri "$assets/app" -TimeoutSec 10 -UseBasicParsing
  $bundle = ($html.Content | Select-String -Pattern '/assets/[A-Za-z0-9_.-]+\.js' -AllMatches).Matches.Value | Select-Object -Unique
  $found = $false
  foreach ($b in $bundle) {
    $js = Invoke-WebRequest -Uri "$assets$b" -TimeoutSec 30 -UseBasicParsing
    if ($js.Content -match 'RyVibe') { $found = $true }
  }
  Write-Output "[portable] 前端包里有 RyVibe = $found"
  $after = @(Get-ChildItem $env:TEMP -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
  $new = $after | Where-Object { $before -notcontains $_ }
  Write-Output "[portable] 启动后临时目录新增 = $($new -join ', ')"
} finally {
  # 按**进程树**杀，不只杀壳。
  #
  # portable.exe 是自解压壳：它把真正的 RyHarness.exe 解到临时目录再启动。只杀壳
  # （Stop-Process -Id）的话，那几个 RyHarness.exe 会活下来占着 32100/32101——下一个
  # 冒烟连上去是个 token 不匹配的旧实例，报错长得还像"包坏了"。这个坑真踩过：
  # zip 冒烟因此报 401，而包本身一点问题都没有。
  if ($null -ne $proc) {
    try { taskkill /PID $proc.Id /T /F | Out-Null } catch { }
  }
  Start-Sleep -Seconds 2
  # 兜底：portable.exe 是自解压壳，它把真正的 RyHarness.exe 解到临时目录后**独立启动**，
  # 那个进程不在壳的进程树上，taskkill /T 只杀得到壳自己。漏下来的那几个会一直占着
  # 发布目录里的 RyHarness-portable.exe 文件锁——下一次打包就在复制这一步 EBUSY 失败
  # （真踩过：package:release 跑到最后一个产物才炸）。
  # 这里按路径收尾：只动临时目录下的 RyHarness.exe 和本次那个 exe 本身，
  # 用户自己开着跑在项目目录里的开发实例不在此列。
  Get-Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.ProcessName -like 'RyHarness*' -and $null -ne $_.Path -and (
        $_.Path.StartsWith($env:TEMP, [System.StringComparison]::OrdinalIgnoreCase) -or
        $_.Path -eq $exe
      )
    } |
    ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } catch { } }
  Start-Sleep -Seconds 1
  $left = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessName -like 'RyHarness*' -and $null -ne $_.Path -and (
      $_.Path.StartsWith($env:TEMP, [System.StringComparison]::OrdinalIgnoreCase) -or
      $_.Path -eq $exe
    )
  })
  Write-Output "[portable] 收尾后残留进程 = $($left.Count)（必须为 0，否则下回打包会被文件锁卡住）"
  Remove-Item -LiteralPath $data -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Output '[portable] done'
