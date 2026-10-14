<#
.SYNOPSIS
  抓 RyAgent 应用窗口的**窗口矩形**——只截窗口本身，桌面、其他应用、任务栏一律不入镜。

.DESCRIPTION
  为什么必须抓窗口而不是整屏：整屏截图会把桌面上的一切（IDE、游戏、聊天窗口、
  桌面壁纸上的私人照片）一起拍进来。仓库历史里的 docs/review3/live-*.png 就是这么
  拍的，泄漏了开发者桌面上的私人头像与文档内容——这类图片不该进版本库。

  DPI：窗口矩形取自 DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)，它返回的
  永远是**物理像素**（本机 150% 缩放下也对），不受调用方进程感知状态影响；因此不再
  用宿主 PowerShell 的 [Screen]::PrimaryScreen.Bounds——那个值在 DPI 未感知的宿主里是
  虚拟化坐标，与物理像素混用会把窗口裁掉一块（历史版本的第二个 bug）。

  抓帧策略（两条都实现，按顺序降级）：
  1. PrintWindow + PW_RENDERFULLCONTENT：让窗口把自己画进内存位图，被遮挡也能抓，
     且完全不读屏幕缓冲区——这是唯一不会泄漏桌面的路径。
  2. 若窗口**确实是前台窗口**，退化为按窗口矩形抓屏幕（Chromium/DirectComposition
     窗口偶尔让 PrintWindow 返回全黑，实测会产生纯色废帧，见历史 w2-a-welcome.png）。
     前台未确认时宁可报错退出，也不把桌面当成窗口拍下来。

  无论走哪条路径，抓完都做亮度方差校验：整幅纯色（方差 ≈ 0，即空白帧/黑屏）视为失败，
  重试一次后仍失败则 exit 1 且**不落盘**——废帧留在仓库里比没有帧更糟。

  实现说明：C# 只做 Win32 + 裸像素拷贝，不碰 System.Drawing。PowerShell 5.1 与 7 的
  Add-Type 对 System.Drawing 的程序集引用方式不同（7 里类型转发到 System.Drawing.Common，
  5.1 里引用列表又必须自带 System.dll），交给 C# 引用必然在其中一个版本上编译失败。
  位图组装与 PNG 编码留给 PowerShell，两边行为一致。

.PARAMETER Out
  输出 PNG 路径。

.PARAMETER WindowTitle
  目标窗口标题的匹配串，默认 RyAgent。

.EXAMPLE
  pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/capture-window.ps1 docs/shot.png
#>
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$WindowTitle = 'RyAgent',
  [double]$MinStdev = 1.5
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;

/** 一帧 BGRA 像素（top-down），宽度 4 字节对齐，与 32bpp DIB 一致。 */
public sealed class Frame {
  public int Width;
  public int Height;
  public byte[] Pixels;
}

public static class WinCapture {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  public struct BITMAPINFOHEADER {
    // biPlanes/biBitCount 是 WORD（2 字节），写成 int 会让结构体变成 44 字节，
    // CreateDIBSection 直接失败并返回空句柄（历史上就是这么白抓了一张）。
    public int biSize, biWidth, biHeight;
    public ushort biPlanes, biBitCount;
    public int biCompression, biSizeImage, biXPelsPerMeter, biYPelsPerMeter, biClrUsed, biClrImportant;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct BITMAPINFO { public BITMAPINFOHEADER bmiHeader; public int bmiColors; }

  public const uint PW_RENDERFULLCONTENT = 0x00000002;
  public const int DWMWA_EXTENDED_FRAME_BOUNDS = 9;

  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr ctx);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hwnd);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr hdc);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr hdc);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr obj);
  [DllImport("gdi32.dll")] static extern IntPtr CreateDIBSection(IntPtr hdc, ref BITMAPINFO bmi, uint usage, out IntPtr bits, IntPtr section, uint offset);
  [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);

  /** 进程级 DPI 感知：PER_MONITOR_AWARE_V2 = -4。返回 false 说明宿主已定过感知级别，无妨。 */
  public static bool MakeDpiAware() {
    if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return true;
    return SetProcessDPIAware();
  }

  /** 窗口物理像素矩形。优先 DWM 可视边框（150% 缩放不虚拟化），失败再按 GetDpiForWindow 换算。 */
  public static bool PhysicalRect(IntPtr h, out RECT r) {
    if (DwmGetWindowAttribute(h, DWMWA_EXTENDED_FRAME_BOUNDS, out r, Marshal.SizeOf(typeof(RECT))) == 0) return true;
    RECT logical;
    if (!GetWindowRect(h, out logical)) return false;
    uint dpi = GetDpiForWindow(h);
    double scale = dpi == 0 ? 1.0 : dpi / 96.0;
    r.Left = (int)Math.Round(logical.Left * scale);
    r.Top = (int)Math.Round(logical.Top * scale);
    r.Right = (int)Math.Round(logical.Right * scale);
    r.Bottom = (int)Math.Round(logical.Bottom * scale);
    return true;
  }

  [DllImport("dwmapi.dll")]
  static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);

  /** PrintWindow 抓帧：窗口自绘进位图，不读屏幕。 */
  public static Frame ViaPrintWindow(IntPtr hwnd, int width, int height) {
    return Grab(width, height, hwnd, default(RECT), true);
  }

  /** 按窗口矩形抓屏。调用方须先确认窗口在前台，否则拍到的是遮挡物。 */
  public static Frame ViaScreenRect(RECT r) {
    return Grab(r.Right - r.Left, r.Bottom - r.Top, IntPtr.Zero, r, false);
  }

  static Frame Grab(int width, int height, IntPtr hwnd, RECT rect, bool printWindow) {
    IntPtr screen = GetDC(IntPtr.Zero);
    IntPtr memDC = CreateCompatibleDC(screen);
    IntPtr bits = IntPtr.Zero;
    BITMAPINFO bmi = new BITMAPINFO();
    bmi.bmiHeader.biSize = Marshal.SizeOf(typeof(BITMAPINFOHEADER));
    bmi.bmiHeader.biWidth = width;
    bmi.bmiHeader.biHeight = -height;   // 负数 = top-down，省掉一次翻转
    bmi.bmiHeader.biPlanes = 1;
    bmi.bmiHeader.biBitCount = 32;
    bmi.bmiHeader.biCompression = 0;    // BI_RGB
    IntPtr dib = CreateDIBSection(memDC, ref bmi, 0, out bits, IntPtr.Zero, 0);
    IntPtr previous = SelectObject(memDC, dib);
    try {
      if (printWindow) {
        PrintWindow(hwnd, memDC, PW_RENDERFULLCONTENT);
      } else {
        BitBlt(memDC, 0, 0, width, height, screen, rect.Left, rect.Top, 0x00CC0020); // SRCCOPY
      }
      Frame frame = new Frame();
      frame.Width = width;
      frame.Height = height;
      frame.Pixels = new byte[width * height * 4];
      Marshal.Copy(bits, frame.Pixels, 0, frame.Pixels.Length);
      return frame;
    } finally {
      SelectObject(memDC, previous);
      DeleteObject(dib);
      DeleteDC(memDC);
      ReleaseDC(IntPtr.Zero, screen);
    }
  }

  /**
   * 亮度标准差（0-255 灰度）。真实界面截图远大于 10；整幅纯色（白/黑/底色）≈ 0，
   * 正是「抓到了但其实没抓到」这类废帧的判据。
   */
  public static double LuminanceStdev(Frame frame) {
    byte[] px = frame.Pixels;
    long n = frame.Width * (long)frame.Height;
    double sum = 0, sumSq = 0;
    for (int i = 0; i < px.Length; i += 4) {
      double lum = 0.299 * px[i + 2] + 0.587 * px[i + 1] + 0.114 * px[i];
      sum += lum;
      sumSq += lum * lum;
    }
    double mean = sum / n;
    double variance = sumSq / n - mean * mean;
    return variance > 0 ? Math.Sqrt(variance) : 0;
  }
}
"@

function Fail([string]$Message) {
  Write-Error $Message
  exit 1
}

function Convert-ToBitmap([Frame]$Frame) {
  $bmp = New-Object System.Drawing.Bitmap($Frame.Width, $Frame.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $area = New-Object System.Drawing.Rectangle(0, 0, $Frame.Width, $Frame.Height)
  $locked = $bmp.LockBits($area, [System.Drawing.Imaging.ImageLockMode]::WriteOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  try {
    [System.Runtime.InteropServices.Marshal]::Copy($Frame.Pixels, 0, $locked.Scan0, $Frame.Pixels.Length)
  } finally {
    $bmp.UnlockBits($locked)
  }
  return $bmp
}

# 必须在碰任何图形对象之前设：DWM 矩形本身已是物理像素，这一步只保证退路
# （按矩形抓屏）用同一套坐标，否则会把窗口错位截取。
[void][WinCapture]::MakeDpiAware()

$proc = Get-Process electron -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$WindowTitle*" } |
  Select-Object -First 1
if ($null -eq $proc) { Fail "RyAgent window not found (is the app running? title like '*$WindowTitle*')" }

$hwnd = ($proc.MainWindowHandle)   # 加括号：否则下一行的 [WinCapture]:: 会被解析成数组下标
[WinCapture]::ShowWindow($hwnd, 9) | Out-Null   # SW_RESTORE：最小化状态下取不到有效矩形
[WinCapture]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 900                  # 等置前与重绘稳定，否则容易抓到过渡帧

$rect = New-Object WinCapture+RECT
if (-not [WinCapture]::PhysicalRect($hwnd, [ref]$rect)) { Fail 'failed to read window rectangle' }
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -lt 64 -or $height -lt 64) { Fail "implausible window rectangle ${width}x${height} — refusing to write a bogus file" }

# 1) PrintWindow：唯一不读屏幕的路径。
$frame = [WinCapture]::ViaPrintWindow($hwnd, $width, $height)
$stdev = [WinCapture]::LuminanceStdev($frame)
$source = 'printwindow'

# 2) 退路：窗口确实在前台时，按矩形抓屏（Chromium 偶尔让 PrintWindow 全黑）。
if ($stdev -lt $MinStdev) {
  if ([WinCapture]::GetForegroundWindow() -ne $hwnd) {
    Fail 'PrintWindow produced a blank frame and the window is not foreground; refusing a screen copy that could capture whatever is in front'
  }
  Start-Sleep -Milliseconds 500
  $frame = [WinCapture]::ViaScreenRect($rect)
  $stdev = [WinCapture]::LuminanceStdev($frame)
  $source = 'screen-rect'
}

if ($stdev -lt $MinStdev) { Fail "blank frame (luminance stdev $([math]::Round($stdev,2)) < $MinStdev) — nothing written to $Out" }

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
$bmp = Convert-ToBitmap $frame
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "captured ${width}x${height} (dpi $([WinCapture]::GetDpiForWindow($hwnd)), stdev $([math]::Round($stdev,2)), via $source) -> $Out"
