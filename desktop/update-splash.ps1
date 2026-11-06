# The splash's double while an update installs (Windows). The installer closes Pitchroom before it puts the new one
# in, so main.js (standIn) starts this first, through Windows' own PowerShell (in a console no one sees), where the
# splash is: the same size and colours, its bar swinging in step with it (both by the clock, so the one over the other
# doesn't jump) while the installer starts and takes the old one out; then filling as the new one's files go in (the
# app's folder filling up again, against how big it was). It goes when the new Pitchroom shows a window (its splash,
# in the same place), or after -Ttl seconds whatever happens.
#
#   -X -Y -W -H   the splash, in the screen's pixels      -Scale  its screen's scale (1 at 100 %)
#   -Bg -Track -Fill   #AARRGGBB                          -Old    the Pitchroom that's quitting (its process id)
#   -Dir   the app's folder (the installer's)             -App    the new one's process name (its window shown: this goes)
#   -Ready   a file written once it's on screen
#   -Text   the line under the bar (the splash's, as it is)   -Progress   the line once the new files go in ({0}: the %)
#   -Ink    the line's colour, #AARRGGBB
param([int]$X, [int]$Y, [int]$W, [int]$H, [double]$Scale = 1, [string]$Bg = "#FF0E0E0E", [string]$Track = "#1FFFFFFF",
      [string]$Fill = "#FFD4D4D4", [string]$Ink = "#80FFFFFF", [string]$Text = "", [string]$Progress = "{0}%", [int]$Old = 0,
      [string]$Dir = "", [int]$Ttl = 180, [string]$App = "Pitchroom", [Parameter(Mandatory)][string]$Ready)
$ErrorActionPreference = "Stop"
# It's started with no console window; should one show all the same, it says what it is, so it isn't closed by mistake
try { $Host.UI.RawUI.WindowTitle = "Pitchroom is updating"; Write-Host "Pitchroom is updating. This window closes by itself." } catch {}

Add-Type -ReferencedAssemblies PresentationCore, PresentationFramework, WindowsBase, System.Xaml -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
public static class PRSplash {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
  // CSS's ease-in-out, cubic-bezier(0.42, 0, 0.58, 1): x to t (Newton), then t to y
  static double Bez(double a, double b, double t) { return 3 * a * (1 - t) * (1 - t) * t + 3 * b * (1 - t) * t * t + t * t * t; }
  public static double Ease(double x) {
    double t = x;
    for (int i = 0; i < 8; i++) {
      double f = Bez(0.42, 0.58, t) - x, d = 3 * 0.42 * (1 - t) * (1 - t) + 6 * (0.58 - 0.42) * (1 - t) * t + 3 * (1 - 0.58) * t * t;
      if (Math.Abs(f) < 1e-7 || d < 1e-6) break;
      t = Math.Max(0, Math.Min(1, t - f / d));
    }
    return Bez(0, 1, t);
  }
  // the bytes in a folder, what can be read of it as it changes
  public static long Bytes(string dir) {
    long n = 0;
    try {
      foreach (var f in new DirectoryInfo(dir).EnumerateFiles("*", SearchOption.AllDirectories)) { try { n += f.Length; } catch { } }
    } catch { }
    return n;
  }
  static volatile int done = -1; // how far the install is, in thousandths: -1 till the new files start going in
  // The installer takes the old app out of its folder, then puts the new one in: the folder going down to its least,
  // then up again (the new one about as big as the old). Not by the files' dates: Windows can give a file made again
  // where one was just taken out that one's date of making.
  public static void Watch(string dir) {
    if (string.IsNullOrEmpty(dir)) return;
    long total = Bytes(dir); // the app as it is, before the installer's begun
    if (total <= 0) return;
    var t = new Thread(() => {
      long least = total; const long MB = 1 << 20;
      while (true) {
        Thread.Sleep(400);
        long now = Bytes(dir);
        if (now < least) least = now;
        if (least < total - 16 * MB && now > least + MB) done = (int)Math.Min(1000, (now - least) * 1000 / Math.Max(1, total - least));
      }
    });
    t.IsBackground = true; t.Start();
  }
  public static int Done() { return done; }
  // splash.html's bar, every frame: swinging by the clock (Date.now() % 1800 there: 0.9 s out, 0.9 s back), then
  // once the new files are going in, filling from the left (easing to where it's got to, as the splash's 0.2 s width)
  public static void Run(FrameworkElement piece, double from, double span, double width, TextBlock line, string progress) {
    double shown = 0; bool filling = false; int said = -1;
    CompositionTarget.Rendering += (s, e) => {
      int d = done;
      if (d >= 0 && d / 10 != said) { said = d / 10; line.Text = string.Format(progress, said); }
      if (d < 0) {
        double ms = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() % 1800, x = ms < 900 ? ms / 900 : (1800 - ms) / 900;
        Canvas.SetLeft(piece, from + span * Ease(x));
        return;
      }
      if (!filling) { filling = true; Canvas.SetLeft(piece, from); }
      shown += (d / 1000.0 - shown) * 0.15;
      piece.Width = Math.Max(0, shown * width);
    };
  }
}
'@
[void][PRSplash]::SetProcessDpiAwarenessContext([IntPtr]-4) # per monitor (v2): drawn in the screen's own pixels, not stretched
[PRSplash]::Watch($Dir) # (before the installer's begun: the app's size as it is)

$brush = { param($c) $b = [Windows.Media.SolidColorBrush]([Windows.Media.ColorConverter]::ConvertFromString($c)); $b.Freeze(); $b }
$win = New-Object Windows.Window -Property @{
  WindowStyle = "None"; ResizeMode = "NoResize"; ShowInTaskbar = $false; ShowActivated = $false; Title = "Pitchroom"
  Background = (& $brush $Bg); WindowStartupLocation = "Manual"; Left = 0; Top = 0; Width = 10; Height = 10
  UseLayoutRounding = $true; SnapsToDevicePixels = $true; BorderBrush = (& $brush "#FF202020") # (the edge Windows gives the splash)
}
$canvas = New-Object Windows.Controls.Canvas
$barTrack = New-Object Windows.Shapes.Rectangle -Property @{ Fill = (& $brush $Track) }
$barFill = New-Object Windows.Shapes.Rectangle -Property @{ Fill = (& $brush $Fill) }
$line = New-Object Windows.Controls.TextBlock -Property @{ Text = $Text; Foreground = (& $brush $Ink); TextAlignment = "Center"; FontFamily = "Segoe UI"
  LineStackingStrategy = "BlockLineHeight"; TextWrapping = "NoWrap" }
[Windows.Documents.Typography]::SetNumeralAlignment($line, "Tabular") # (the % not jittering, as the splash's tabular-nums)
[void]$canvas.Children.Add($barTrack); [void]$canvas.Children.Add($barFill); [void]$canvas.Children.Add($line)
$win.Content = $canvas

$win.Add_SourceInitialized({
  $hwnd = (New-Object Windows.Interop.WindowInteropHelper $win).Handle
  $square = 1; [void][PRSplash]::DwmSetWindowAttribute($hwnd, 33, [ref]$square, 4) # square corners, as the splash's
  $d = [Windows.Media.VisualTreeHelper]::GetDpi($win).DpiScaleX # this window's units to pixels
  $win.BorderThickness = New-Object Windows.Thickness (1 / $d) # its 1 px edge, as Windows draws the splash's
  $win.Left = $X / $d; $win.Top = $Y / $d; $win.Width = $W / $d; $win.Height = $H / $d # where the splash is (to the pixel once it's shown)
  # the splash's bar (splash.html): 168 x 2 px in the middle, its piece 32 % of it, from 0 to 68 % and back
  $u = $Scale / $d # a splash px in this window's units
  $iw = ($W - 2) / $d; $ih = ($H - 2) / $d # inside the edge (where the canvas is), the same middle
  $bw = 168 * $u; $bh = 2 * $u; $left = ($iw - $bw) / 2; $top = ($ih - $bh) / 2
  $barTrack.Width = $bw; $barTrack.Height = $bh; $barTrack.RadiusX = $barTrack.RadiusY = $bh / 2
  $barFill.Width = 0.32 * $bw; $barFill.Height = $bh
  [Windows.Controls.Canvas]::SetLeft($barTrack, $left); [Windows.Controls.Canvas]::SetTop($barTrack, $top); [Windows.Controls.Canvas]::SetTop($barFill, $top)
  # the line (splash.html's .line): 12 px on a 16 px line, its top 13 px under the middle, across the window
  $line.FontSize = 12 * $u; $line.LineHeight = 16 * $u; $line.Width = $iw
  [Windows.Controls.Canvas]::SetLeft($line, 0); [Windows.Controls.Canvas]::SetTop($line, $ih / 2 + 13 * $u + 1 / $d) # (+1 px: WPF sets its text a pixel higher than Chromium)
  [PRSplash]::Run($barFill, $left, 0.68 * $bw, $bw, $line, $Progress)
})
$win.Add_ContentRendered({
  [void][PRSplash]::SetWindowPos((New-Object Windows.Interop.WindowInteropHelper $win).Handle, [IntPtr]::Zero, $X, $Y, $W, $H, 0x0014) # (no z-order change, not activated)
  [IO.File]::WriteAllText($Ready, "ready") # (main.js waits for it: then the app can go)
})

$start = Get-Date; $script:gone = ($Old -eq 0)
$tick = New-Object Windows.Threading.DispatcherTimer -Property @{ Interval = [TimeSpan]::FromMilliseconds(200) }
$tick.Add_Tick({
  if (((Get-Date) - $start).TotalSeconds -gt $Ttl) { $win.Close(); return }
  $d = [PRSplash]::Done(); if ($d -ge 0) { try { $Host.UI.RawUI.WindowTitle = "Pitchroom is updating $([int]($d / 10))%" } catch {} }
  if (-not $script:gone) { $script:gone = -not (Get-Process -Id $Old -ErrorAction SilentlyContinue); return } # the old one still closing
  if (Get-Process -Name $App -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $PID -and $_.MainWindowHandle -ne 0 }) { $win.Close() } # the new one's up
})
$tick.Start()
[void]$win.ShowDialog()
