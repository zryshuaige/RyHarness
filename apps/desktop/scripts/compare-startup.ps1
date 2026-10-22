# 对比两种「不用安装」的启动成本：解压版（zip）与便携版（自解压 exe）。
#
# 两个坑都会让数字失真，这里都堵上：
# 1) 上一轮的实例还占着端口时，第二轮的请求会打到**旧进程**上，测出 0.2 秒这种假数。
#    所以每轮用不同的后端端口，且启动前先确认那个端口没人应。
# 2) 便携版每次启动都把运行时解到临时目录，这一下才是它真正的成本。

$ErrorActionPreference = 'Stop'
$zip = 'F:\AgenticResearch\RyAgent\apps\desktop\ryharness-release\RyHarness-win-x64.zip'
$work = Join-Path $env:TEMP ('ryharness-cmp-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
New-Item -ItemType Directory -Force -Path $work | Out-Null

function Wait-PortFree($port) {
  for ($i = 0; $i -lt 60; $i++) {
    $busy = $false
    try {
      Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/agents" -TimeoutSec 1 -UseBasicParsing | Out-Null
      $busy = $true
    } catch {
      if ($_.Exception.Response.StatusCode.value__ -eq 401) { $busy = $true }
    }
    if (-not $busy) { return }
    Start-Sleep -Milliseconds 500
  }
  throw "端口 $port 一直被占着"
}

function Measure-Launch($exe, $label, $port) {
  $data = Join-Path $work ('data-' + $label)
  New-Item -ItemType Directory -Force -Path $data | Out-Null
  Wait-PortFree $port
  $env:CI = 'true'
  $env:RYHARNESS_API_TOKEN = 'cmp-token'
  $env:RYHARNESS_DATA_DIR = $data
  $env:RYHARNESS_PORT = "$port"
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $proc = Start-Process -FilePath $exe -PassThru
  try {
    for ($i = 0; $i -lt 200; $i++) {
      Start-Sleep -Milliseconds 200
      try {
        Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/agents" -TimeoutSec 2 -UseBasicParsing | Out-Null
        break
      } catch {
        if ($_.Exception.Response.StatusCode.value__ -eq 401) { break }
      }
    }
    $sw.Stop()
    Write-Output "$label = $([math]::Round($sw.Elapsed.TotalSeconds,1)) 秒"
  } finally {
    if ($null -ne $proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
  }
}

Write-Output '[cmp] 解压 zip…'
Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $work 'app') -Force
$unpacked = Get-ChildItem (Join-Path $work 'app') -Recurse -Filter 'RyHarness.exe' | Select-Object -First 1
Measure-Launch $unpacked.FullName '解压版（zip 里的 exe）' 32100
Measure-Launch 'F:\AgenticResearch\RyAgent\apps\desktop\ryharness-release\RyHarness-portable.exe' '便携版（自解压 exe）' 32110
Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
