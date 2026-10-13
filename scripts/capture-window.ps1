# 真机截图：抓 RyAgent 窗口所在屏幕（把窗口置前后整屏抓图）。
#
# 为什么不用 PrintWindow + GetWindowRect：这台机器 150% 缩放下，宿主 PowerShell
# 拿到的 GetWindowRect 是 96dpi 虚拟化坐标，而 PrintWindow 画的是物理像素，
# 两者混用会把图裁掉一块。整屏抓图没有这个问题，代价是背景也会入镜。
#
# 用法：pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/capture-window.ps1 <输出路径>
param([Parameter(Mandatory = $true)][string]$Out)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinCap {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
}
"@

$proc = Get-Process electron -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowTitle -like '*RyAgent*' } |
  Select-Object -First 1
if ($null -eq $proc) { throw 'RyAgent window not found (is the app running?)' }

[WinCap]::ShowWindow($proc.MainWindowHandle, 9) | Out-Null   # 先还原，保证置前后都可见
[WinCap]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 900

$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bounds.Size)
$graphics.Dispose()
$bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
Write-Output "captured $($bounds.Width)x$($bounds.Height) -> $Out"