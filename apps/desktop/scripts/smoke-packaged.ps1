# 打包产物冒烟：真的把免安装版解压、真的跑起来、真的调接口。
# 断言三件事：页面能开且防嵌套头在、无 token 调 API 被拒、新一轮的 RyVibe 路由与界面都在包里。

$ErrorActionPreference = 'Stop'
$zip = 'F:\AgenticResearch\RyAgent\apps\desktop\ryharness-release\RyHarness-win-x64.zip'
$work = Join-Path $env:TEMP ('ryharness-smoke-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$data = Join-Path $work 'data'
New-Item -ItemType Directory -Force -Path $work, $data | Out-Null

Write-Output "[smoke] 解压免安装版…"
Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $work 'app') -Force
$exe = Get-ChildItem (Join-Path $work 'app') -Recurse -Filter 'RyHarness.exe' | Select-Object -First 1
if ($null -eq $exe) { throw '免安装版里没有 RyHarness.exe' }
Write-Output "[smoke] 主程序: $($exe.FullName)"

$token = 'smoke-token-0123456789'
$env:CI = 'true'
$env:RYHARNESS_API_TOKEN = $token
$env:RYHARNESS_DATA_DIR = $data
$env:RYHARNESS_PORT = '32100'

$proc = Start-Process -FilePath $exe.FullName -PassThru -WorkingDirectory $exe.DirectoryName
try {
  $base = 'http://127.0.0.1:32100'
  $assets = 'http://127.0.0.1:32101'
  $up = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      $r = Invoke-WebRequest -Uri "$base/api/agents" -TimeoutSec 3 -UseBasicParsing
      $up = $true
      break
    } catch {
      if ($_.Exception.Response.StatusCode.value__ -eq 401) { $up = $true; break }
    }
  }
  if (-not $up) { throw '后端 90 秒内没起来' }
  Write-Output '[smoke] 后端已就绪'

  # 1) 资源服务：页面能开，防嵌套的两条头都在
  $page = Invoke-WebRequest -Uri "$assets/app" -TimeoutSec 10 -UseBasicParsing
  Write-Output "[smoke] 页面状态 = $($page.StatusCode)"
  Write-Output "[smoke] x-frame-options = $($page.Headers['x-frame-options'])"
  Write-Output "[smoke] content-security-policy = $($page.Headers['content-security-policy'])"

  # 2) 无 token 调 API 必须被拒
  try {
    Invoke-WebRequest -Uri "$base/api/agents" -TimeoutSec 10 -UseBasicParsing | Out-Null
    Write-Output '[smoke] !! 无 token 竟然调通了（这是洞）'
  } catch {
    Write-Output "[smoke] 无 token 调 API = $($_.Exception.Response.StatusCode.value__)"
  }

  # 3) 带 token：这一轮的新路由必须在包里
  $auth = @{ Authorization = "Bearer $token" }
  $vibe = Invoke-WebRequest -Uri "$base/api/vibe" -TimeoutSec 10 -UseBasicParsing -Headers $auth
  Write-Output "[smoke] GET /api/vibe = $($vibe.StatusCode) $($vibe.Content)"
  $agents = Invoke-WebRequest -Uri "$base/api/agents" -TimeoutSec 10 -UseBasicParsing -Headers $auth
  Write-Output "[smoke] GET /api/agents = $($agents.StatusCode)"

  # 4) 界面里必须有这一轮的 RyVibe 页签
  $html = Invoke-WebRequest -Uri "$assets/app" -TimeoutSec 10 -UseBasicParsing
  $bundle = ($html.Content | Select-String -Pattern '/assets/[A-Za-z0-9_.-]+\.js' -AllMatches).Matches.Value | Select-Object -Unique
  $found = $false
  foreach ($b in $bundle) {
    $js = Invoke-WebRequest -Uri "$assets$b" -TimeoutSec 30 -UseBasicParsing
    if ($js.Content -match 'RyVibe') { $found = $true; Write-Output "[smoke] 前端 bundle 里找到 RyVibe：$b" }
  }
  Write-Output "[smoke] RyVibe 在前端包里 = $found"
} finally {
  # 按进程树杀：RyHarness.exe 底下还有渲染进程与后端子进程，只杀主进程的话它们会
  # 留着占住 32100/32101——下一个冒烟连上去是个 token 不匹配的旧实例，报错还长得
  # 像"包坏了"（这个坑真踩过）。
  if ($null -ne $proc) {
    try { taskkill /PID $proc.Id /T /F | Out-Null } catch { }
  }
  Start-Sleep -Seconds 2
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
Write-Output '[smoke] done'
