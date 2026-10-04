#Requires -Version 5.1
<#
.SYNOPSIS
    Capture what the dsh-tabs window currently looks like.

.DESCRIPTION
    A picture is reviewable and a build log is not. This launches the application,
    lets it settle, then captures the window's client area into `.shots\` — which
    is the folder the harness can read back and show.

    Three things about the capture were measured rather than assumed, and each one
    rules out the obvious implementation:

    * **`PrintWindow` answers with a stale frame.** It is the polite way to capture
      a window — no screen read, no need for the window to be visible — and on
      Electron 44.0.0/Chromium 152 it returns the last frame Chromium produced
      before the window was occluded. Five shots of five different states came back
      byte-identical (`18BBBA1FC79A6E4C`), while a screen read of the same rectangle
      at the same moment differed. So the screen read is the capture, not the
      fallback.
    * **The window therefore has to be on top while it is captured.** Chromium stops
      producing frames for an occluded window, and this one is occluded by whatever
      the operator is actually working in. `SetWindowPos(HWND_TOPMOST)` brings it up
      without taking focus (`SWP_NOACTIVATE`), which is enough for it to paint
      again; the previous Z-order is restored as soon as the frame is taken.
      Launching it with `--disable-backgrounding-occluded-windows` does **not** fix
      this by itself: measured, and the shots were still identical.
    * **The client area is what gets captured, not the window rectangle.** The
      window rectangle is 16x8 pixels larger than the client area and its left edge
      shows whatever is behind the window — the first attempt at this photographed a
      neighbouring window's text along the bottom edge.

    `-NoLaunch` captures the window that is already up, so a series can walk through
    states an application reached on its own — a connect that succeeded, a failure
    that arrived later — without restarting it between shots. Driving it *into* those
    states is not this script's job: it has no window handle to send input to that a
    background session can rely on, which is why the capture series for this
    application is driven through the renderer's own DevTools endpoint instead.

.PARAMETER Label
    Name for the shot, so a series reads in order. Defaults to a counter.

.PARAMETER OutDir
    Where the PNG goes. Defaults to `<repo>\.shots`.

.PARAMETER SettleMs
    Milliseconds to wait after the window appears before capturing. A first paint
    and a first network round trip both need time to finish.

.PARAMETER NoLaunch
    Do not launch the application; capture the window that is up right now.

.PARAMETER Close
    Close the window when the capture is done, by the polite path: a WM_CLOSE, so
    the application runs its own teardown and does not leak a local Harness.

.PARAMETER Title
    Window title to look for. Defaults to `dsh-tabs`.

.PARAMETER Composite
    Also scale the shot down to a shareable width and save it beside the original
    as `<name>.small.png`.

.EXAMPLE
    .\tools\shot.ps1 -Label 01-launch
    .\tools\shot.ps1 -Label 02-ready -NoLaunch
    .\tools\shot.ps1 -Label 03-two-tabs -NoLaunch -Close
#>
[CmdletBinding()]
param(
	[string]$Label,
	[string]$OutDir,
	[int]$SettleMs = 6000,
	[switch]$NoLaunch,
	[switch]$Close,
	[string]$Title = 'dsh-tabs',
	[switch]$Composite
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $root '.shots' }

Add-Type -AssemblyName System.Drawing

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Win {
	[StructLayout(LayoutKind.Sequential)]
	public struct RECT { public int Left, Top, Right, Bottom; }
	[StructLayout(LayoutKind.Sequential)]
	public struct POINT { public int X, Y; }

	[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
	[DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT rect);
	[DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hWnd, ref POINT point);
	[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
	[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
	[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
	[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
	[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@

# Without this the rectangles come back in virtualised coordinates on a scaled
# display and the shot is captured at the wrong size.
[void][Win]::SetProcessDPIAware()

$SWP_NOSIZE = 0x0001
$SWP_NOMOVE = 0x0002
$SWP_NOACTIVATE = 0x0010
$HWND_TOPMOST = [IntPtr](-1)
$HWND_NOTOPMOST = [IntPtr](-2)

function Get-AppWindow {
	$found = Get-Process -Name electron -ErrorAction SilentlyContinue |
		Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and $_.MainWindowTitle -like "*$Title*" }
	if (-not $found) { return $null }
	return $found | Select-Object -First 1
}

$app = Get-AppWindow

if (-not $app -and -not $NoLaunch) {
	# Electron refuses to start when ELECTRON_RUN_AS_NODE is set, and answers with
	# a version of Node rather than a window when asked what it is. It is set in
	# some shells and invisible in every check except this one.
	$env:ELECTRON_RUN_AS_NODE = $null
	$exe = Join-Path $root 'node_modules\electron\dist\electron.exe'
	if (-not (Test-Path $exe)) { throw "no Electron binary at $exe — run: npm run install-electron" }

	Write-Host "launching $exe ."
	Start-Process -FilePath $exe -ArgumentList '.' -WorkingDirectory $root | Out-Null

	$deadline = (Get-Date).AddSeconds(45)
	while (-not ($app = Get-AppWindow)) {
		if ((Get-Date) -gt $deadline) { throw "no window titled '$Title' appeared within 45s" }
		Start-Sleep -Milliseconds 250
	}
	Write-Host "window is up: pid $($app.Id)"
}

if (-not $app) { throw "no window titled '$Title' is up; drop -NoLaunch to start one" }

Start-Sleep -Milliseconds $SettleMs
[void][Win]::ShowWindow($app.MainWindowHandle, 9)   # SW_RESTORE

# The window has to be unoccluded for Chromium to paint at all, and unoccluded
# without being focused: the capture must not take the keyboard away from whoever
# is using the machine.
[void][Win]::SetWindowPos($app.MainWindowHandle, $HWND_TOPMOST, 0, 0, 0, 0, $SWP_NOSIZE -bor $SWP_NOMOVE -bor $SWP_NOACTIVATE)
Start-Sleep -Milliseconds 1200

$client = New-Object 'Win+RECT'
if (-not [Win]::GetClientRect($app.MainWindowHandle, [ref]$client)) { throw 'GetClientRect failed' }
$width = $client.Right
$height = $client.Bottom
if ($width -le 0 -or $height -le 0) { throw "the window reports a ${width}x${height} client area" }

$origin = New-Object 'Win+POINT'
if (-not [Win]::ClientToScreen($app.MainWindowHandle, [ref]$origin)) { throw 'ClientToScreen failed' }

$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($origin.X, $origin.Y, 0, 0, (New-Object System.Drawing.Size($width, $height)))
$graphics.Dispose()

# Put the window back where it was. `PrintWindow` is kept as the fallback for the
# case where the screen read is refused — a locked session, mostly.
if ($bitmap.GetPixel(4, 4).A -eq 0) {
	Write-Warning 'the screen read came back empty; asking the window to render itself instead'
	$bitmap.Dispose()
	$bitmap = New-Object System.Drawing.Bitmap($width, $height)
	$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
	$hdc = $graphics.GetHdc()
	$null = [Win]::PrintWindow($app.MainWindowHandle, $hdc, 2)
	$graphics.ReleaseHdc($hdc)
	$graphics.Dispose()
}

[void][Win]::SetWindowPos($app.MainWindowHandle, $HWND_NOTOPMOST, 0, 0, 0, 0, $SWP_NOSIZE -bor $SWP_NOMOVE -bor $SWP_NOACTIVATE)

# A uniformly coloured frame means the capture mechanism worked and the window
# painted nothing — the failure that would otherwise look like a valid shot.
$first = $bitmap.GetPixel(4, 4)
$flat = $true
foreach ($point in @(@(20, 20), @([int]($width / 2), [int]($height / 2)), @(($width - 20), ($height - 20)))) {
	$pixel = $bitmap.GetPixel($point[0], $point[1])
	if ($pixel.R -ne $first.R -or $pixel.G -ne $first.G -or $pixel.B -ne $first.B) { $flat = $false; break }
}
if ($flat) { Write-Warning 'every sampled pixel is the same colour — the shot is probably blank' }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
if (-not $Label) { $Label = 'shot' }
$index = @(Get-ChildItem -Path $OutDir -Filter '*.png' -ErrorAction SilentlyContinue |
	Where-Object { $_.Name -match '^(\d+)-' } |
	ForEach-Object { [int]($_.Name -split '-')[0] } |
	Sort-Object -Descending | Select-Object -First 1)
$next = if ($index.Count -gt 0) { $index[0] + 1 } else { 1 }
$name = '{0:d2}-{1}' -f $next, $Label
$path = Join-Path $OutDir "$name.png"
$bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)

if ($Composite) {
	$target = 1024
	if ($width -gt $target) {
		$scale = $target / $width
		$small = New-Object System.Drawing.Bitmap($target, [int]($height * $scale))
		$canvas = [System.Drawing.Graphics]::FromImage($small)
		$canvas.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
		$canvas.DrawImage($bitmap, 0, 0, $small.Width, $small.Height)
		$canvas.Dispose()
		$small.Save((Join-Path $OutDir "$name.small.png"), [System.Drawing.Imaging.ImageFormat]::Png)
		$small.Dispose()
	}
}

$bitmap.Dispose()
Write-Host "saved $path (${width}x${height})"

if ($Close) {
	[void][Win]::PostMessage($app.MainWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
	Write-Host 'asked the window to close'
}
