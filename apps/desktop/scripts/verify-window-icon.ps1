# Probe live JIDE window icons via WM_GETICON + class icon, pixel-compare vs neon-j-32.png.
# Read-only queries: does not steal focus or disturb fullscreen apps.
# Render path: GetIconInfo copies the icon bitmaps into our process (DrawIcon rejects
#              cross-process icon handles in some GDI paths).
# NOTE: keep this file ASCII-only (PS 5.1 reads BOM-less scripts as ANSI; CJK comment
#       bytes can swallow the newline and comment out the next code line).
[void][Reflection.Assembly]::LoadWithPartialName("System.Drawing")
if (-not ("System.Drawing.Bitmap" -as [type])) { Write-Output "SYSTEM_DRAWING_LOAD_FAIL"; exit 1 }
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class IconQuery {
	[StructLayout(LayoutKind.Sequential)]
	public struct ICONINFO { public bool fIcon; public int xHotspot; public int yHotspot; public IntPtr hbmMask; public IntPtr hbmColor; }
	[DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
	[DllImport("user32.dll", EntryPoint = "GetClassLongPtrW")] public static extern IntPtr GetClassLongPtr(IntPtr hWnd, int nIndex);
	[DllImport("user32.dll")] public static extern bool GetIconInfo(IntPtr hIcon, ref ICONINFO pIconInfo);
	[DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr hObject);
	[DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
}
"@

function Test-IconHandle([string]$Name, [IntPtr]$H) {
	if ($H -eq [IntPtr]::Zero) { Write-Output ($Name + ": <null>"); return }
	$ii = New-Object IconQuery+ICONINFO
	if (-not [IconQuery]::GetIconInfo($H, [ref]$ii)) {
		Write-Output ($Name + ": handle=" + $H + " GetIconInfo-FAIL(err=" + [Runtime.InteropServices.Marshal]::GetLastWin32Error() + ")")
		return
	}
	if ($ii.hbmColor -eq [IntPtr]::Zero) { Write-Output ($Name + ": handle=" + $H + " mask-only(monochrome?)"); [IconQuery]::DeleteObject($ii.hbmMask) | Out-Null; return }
	try {
		$bmp = [System.Drawing.Image]::FromHbitmap($ii.hbmColor)
		$w = $bmp.Width; $h = $bmp.Height
		$src = New-Object System.Drawing.Bitmap("C:\VibeCodingProject\JIDE\apps\desktop\assets\neon-j-32.png")
		$mismatch = 0; $samples = @()
		if ($w -ne 32 -or $h -ne 32) {
			$mismatch = -1  # wrong size, cannot be our 32x32
			$samples += ("size={0}x{1}" -f $w, $h)
		} else {
			foreach ($p in @(@(16,4), @(10,10), @(20,24), @(24,20), @(16,16))) {
				$a = $src.GetPixel($p[0], $p[1]); $b = $bmp.GetPixel($p[0], $p[1])
				# HBITMAP has no alpha channel semantics via FromHbitmap; compare RGB only
				if ($a.R -ne $b.R -or $a.G -ne $b.G -or $a.B -ne $b.B) { $mismatch++; $samples += ("@{0},{1}:want={2},{3},{4} got={5},{6},{7}" -f $p[0], $p[1], $a.R, $a.G, $a.B, $b.R, $b.G, $b.B) }
			}
		}
		$verdict = if ($mismatch -eq 0) { "NEON-J-OK" } elseif ($mismatch -eq -1) { "WRONG-SIZE" } else { "NOT-NEON-J" }
		Write-Output ($Name + ": handle=" + $H + " " + $verdict + " " + ($samples -join "; "))
		$bmp.Dispose(); $src.Dispose()
	} catch {
		Write-Output ($Name + ": render-fail " + $_.Exception.Message)
	} finally {
		[IconQuery]::DeleteObject($ii.hbmColor) | Out-Null
		[IconQuery]::DeleteObject($ii.hbmMask) | Out-Null
	}
}

$proc = Get-Process | Where-Object { $_.MainWindowTitle -eq "JIDE" } | Select-Object -First 1
if (-not $proc) { Write-Output "NO_WINDOW"; exit 1 }
$hwnd = $proc.MainWindowHandle
Write-Output ("WINDOW pid=" + $proc.Id + " hwnd=" + $hwnd)

# WM_GETICON (0x7F): 0=ICON_BIG 1=ICON_SMALL 2=ICON_SMALL2 ; class: GCLP_HICON=-14 GCLP_HICONSM=-34
Test-IconHandle "WM_GETICON BIG"   ([IconQuery]::SendMessage($hwnd, 0x7F, [IntPtr]0, [IntPtr]0))
Test-IconHandle "WM_GETICON SMALL" ([IconQuery]::SendMessage($hwnd, 0x7F, [IntPtr]1, [IntPtr]0))
Test-IconHandle "CLASS HICON"      ([IconQuery]::GetClassLongPtr($hwnd, -14))
Test-IconHandle "CLASS HICONSM"    ([IconQuery]::GetClassLongPtr($hwnd, -34))
