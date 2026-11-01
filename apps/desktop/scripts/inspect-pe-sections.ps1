# 取证脚本2:节表 + Windows 实际解析出的图标
param([string]$Target)
$ErrorActionPreference = 'Continue'
$name = Split-Path $Target -Leaf
$bytes = [IO.File]::ReadAllBytes($Target)

# 1) 节表名称列表
$peOff = [BitConverter]::ToInt32($bytes, 0x3C)
$numSections = [BitConverter]::ToUInt16($bytes, $peOff + 6)
$optSize = [BitConverter]::ToUInt16($bytes, $peOff + 20)
$sectOff = $peOff + 24 + $optSize
$secNames = @()
for ($i = 0; $i -lt $numSections; $i++) {
	$s = $sectOff + $i * 40
	$nm = [Text.Encoding]::ASCII.GetString($bytes, $s, 8).TrimEnd([char]0)
	$secNames += "$nm(rva=0x{0:X},vsize=0x{1:X},raw=0x{2:X})" -f [BitConverter]::ToUInt32($bytes, $s + 12), [BitConverter]::ToUInt32($bytes, $s + 8), [BitConverter]::ToUInt32($bytes, $s + 16)
}
Write-Output "$name SECTIONS: $($secNames -join ' ')"

# 2) Windows 实际关联图标(任务栏/资源管理器用的就是这个)
try {
	Add-Type -AssemblyName System.Drawing
	$ico = [System.Drawing.Icon]::ExtractAssociatedIcon($Target)
	if ($ico) {
		$out = "$env:TEMP\extracted-$name.png"
		$bmp = $ico.ToBitmap()
		$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
		Write-Output "$name ASSOC_ICON ${out} size=$($ico.Width)x$($ico.Height)"
	} else {
		Write-Output "$name ASSOC_ICON NULL"
	}
} catch {
	Write-Output "$name ASSOC_ICON FAIL: $($_.Exception.Message)"
}
