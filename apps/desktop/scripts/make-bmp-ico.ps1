# 从 neon-j-32.png 生成字节级正确的 BMP 帧 .ico(供 patch-exe-icon.ps1 使用)
# 结构:ICONDIR(6) + ICONDIRENTRY(16) + BITMAPINFOHEADER(40) + XOR 像素(自下而上 BGRA) + AND 掩码
# 关键:biHeight 必须 = 2*高(像素 + 掩码),32bpp 下 AND 掩码全 0(透明由 alpha 承担)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$src = "C:\VibeCodingProject\JIDE\apps\desktop\assets\neon-j-32.png"
$dst = "C:\VibeCodingProject\JIDE\apps\desktop\build\icon-bmp.ico"
$size = 32

$bmp = New-Object System.Drawing.Bitmap($src)
if ($bmp.Width -ne $size -or $bmp.Height -ne $size) { throw "source must be ${size}x${size}, got $($bmp.Width)x$($bmp.Height)" }

# XOR 数据:自下而上逐行 BGRA
$xor = New-Object byte[] ($size * $size * 4)
$rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
$data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
for ($y = 0; $y -lt $size; $y++) {
	$srcRow = [IntPtr]::Add($data.Scan0, $y * $data.Stride)
	$rowCopy = New-Object byte[] ($size * 4)
	[System.Runtime.InteropServices.Marshal]::Copy($srcRow, $rowCopy, 0, $rowCopy.Length)
	$dstRow = ($size - 1 - $y) * $size * 4   # 翻成自下而上
	[Array]::Copy($rowCopy, 0, $xor, $dstRow, $rowCopy.Length)
}
$bmp.UnlockBits($data)
$bmp.Dispose()

# AND 掩码:每行 32 位 = 4 字节,全 0,共 size 行 = 128 字节
$rowBytes = 4
$maskAll = New-Object byte[] ($size * $rowBytes)

# BITMAPINFOHEADER(40 字节)
$hdr = New-Object byte[] 40
[Array]::Copy([BitConverter]::GetBytes([uint32]40), 0, $hdr, 0, 4)        # biSize
[Array]::Copy([BitConverter]::GetBytes([int32]$size), 0, $hdr, 4, 4)      # biWidth
[Array]::Copy([BitConverter]::GetBytes([int32]($size * 2)), 0, $hdr, 8, 4) # biHeight = 2*h  ← 上次的坑
[Array]::Copy([BitConverter]::GetBytes([uint16]1), 0, $hdr, 12, 2)        # biPlanes
[Array]::Copy([BitConverter]::GetBytes([uint16]32), 0, $hdr, 14, 2)       # biBitCount
[Array]::Copy([BitConverter]::GetBytes([uint32]0), 0, $hdr, 16, 4)        # biCompression = BI_RGB
$imgLen = $hdr.Length + $xor.Length + $maskAll.Length

# ICONDIRENTRY(16 字节)
$entry = New-Object byte[] 16
$entry[0] = $size; $entry[1] = $size; $entry[2] = 0; $entry[3] = 0
[Array]::Copy([BitConverter]::GetBytes([uint16]1), 0, $entry, 4, 2)
[Array]::Copy([BitConverter]::GetBytes([uint16]32), 0, $entry, 6, 2)
[Array]::Copy([BitConverter]::GetBytes([uint32]$imgLen), 0, $entry, 8, 4)
[Array]::Copy([BitConverter]::GetBytes([uint32]22), 0, $entry, 12, 4)

# ICONDIR(6 字节):reserved=0, type=1, count=1
$dir = New-Object byte[] 6
[Array]::Copy([BitConverter]::GetBytes([uint16]0), 0, $dir, 0, 2)
[Array]::Copy([BitConverter]::GetBytes([uint16]1), 0, $dir, 2, 2)
[Array]::Copy([BitConverter]::GetBytes([uint16]1), 0, $dir, 4, 2)

$out = New-Object IO.MemoryStream
$out.Write($dir, 0, 6); $out.Write($entry, 0, 16); $out.Write($hdr, 0, 40)
$out.Write($xor, 0, $xor.Length); $out.Write($maskAll, 0, $maskAll.Length)
[IO.File]::WriteAllBytes($dst, $out.ToArray())
Write-Output "WROTE $dst bytes=$((Get-Item $dst).Length) expect=$(6 + 16 + $imgLen)"

# 自校验:GDI+ 解码 + 与源 PNG 逐像素比对(Save 的 PS 绑定有坑,不用它做校验)
try {
	$check = New-Object System.Drawing.Icon($dst)
	if (-not $check) { throw "Icon ctor returned null" }
	$tb = $check.ToBitmap()
	if (-not $tb) { throw "ToBitmap returned null" }
	$srcBmp = New-Object System.Drawing.Bitmap($src)
	$mismatch = 0
	foreach ($pt in @([byte[]](0,0),[byte[]](16,4),[byte[]](16,16),[byte[]](31,31),[byte[]](10,10),[byte[]](24,20))) {
		$a = $srcBmp.GetPixel($pt[0], $pt[1]); $b = $tb.GetPixel($pt[0], $pt[1])
		if ($a.R -ne $b.R -or $a.G -ne $b.G -or $a.B -ne $b.B -or $a.A -ne $b.A) { $mismatch++ }
	}
	$srcBmp.Dispose(); $tb.Dispose()
	if ($mismatch -ne 0) { throw "pixel mismatch at $mismatch sample points" }
	Write-Output "SELF_CHECK_OK $($check.Width)x$($check.Height) 6点像素比对全通过"
} catch {
	Write-Output ("SELF_CHECK_FAIL: " + $_.Exception.Message)
	exit 1
}
