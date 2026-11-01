Add-Type @"
using System;
using System.Runtime.InteropServices;
public class ResPatch {
	[DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr BeginUpdateResource(string p, bool del);
	[DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern bool UpdateResource(IntPtr h, uint type, IntPtr name, ushort lang, byte[] data, uint len);
	[DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern bool EndUpdateResource(IntPtr h, bool del);
}
"@
$exe = "C:\VibeCodingProject\JIDE\apps\desktop\build2\dev-win-x64\JIDE-dev\bin\cottontail.exe"
# 幂等:先还原到原始 exe,避免重复合并(同 ID 会替换,但还原更干净)
if (Test-Path "$exe.bak") { Copy-Item "$exe.bak" $exe -Force }
Copy-Item $exe "$exe.bak" -Force
$icoBytes = [IO.File]::ReadAllBytes("C:\VibeCodingProject\JIDE\apps\desktop\build\icon-bmp.ico")
$count = [BitConverter]::ToUInt16($icoBytes, 4)
$h = [ResPatch]::BeginUpdateResource($exe, $false)
if ($h -eq [IntPtr]::Zero) { Write-Output "BEGIN_FAIL"; exit 1 }
$group = New-Object System.Collections.Generic.List[byte]
# GRPICONDIR: reserved(2)=0, type(2)=1(小端 → 01 00), count(2)。上次把第 4 字节写成 count 导致 idType 损坏
$group.AddRange([byte[]](0,0,1,0));
$group.AddRange([BitConverter]::GetBytes([uint16]$count))
for ($i = 0; $i -lt $count; $i++) {
	$off = 6 + $i * 16
	$entry = $icoBytes[$off..($off+15)]
	$len = [BitConverter]::ToUInt32($icoBytes, $off + 8)
	$imgOff = [BitConverter]::ToUInt32($icoBytes, $off + 12)
	$img = New-Object byte[] $len
	[Array]::Copy($icoBytes, $imgOff, $img, 0, $len)
	$id = $i + 1
	if (-not [ResPatch]::UpdateResource($h, 3, [IntPtr]$id, 0, $img, $len)) { Write-Output "UPD_FAIL_ICON $i"; exit 1 }
	$group.AddRange([byte[]]($entry[0..11])); $group.AddRange([BitConverter]::GetBytes([uint16]$id))
}
$gArr = $group.ToArray()
if (-not [ResPatch]::UpdateResource($h, 14, [IntPtr]1, 0, $gArr, $gArr.Length)) { Write-Output "UPD_FAIL_GROUP"; exit 1 }
if (-not [ResPatch]::EndUpdateResource($h, $false)) { Write-Output "END_FAIL $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"; exit 1 }
Write-Output "PATCHED frames=$count size=$((Get-Item $exe).Length)"
