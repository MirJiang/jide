# Find which process holds a JIDE-dev path as its CWD (PEB probe)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class PwdProbe {
  [DllImport("ntdll.dll")]
  public static extern int NtQueryInformationProcess(IntPtr h, int c, ref PBI pbi, int len, out int rl);
  [StructLayout(LayoutKind.Sequential)]
  public struct PBI { public IntPtr Reserved1; public IntPtr PebBaseAddress; public IntPtr Reserved2; public IntPtr UniqueProcessId; public IntPtr Reserved3; }
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(int a, bool inh, int pid);
  [DllImport("kernel32.dll")] public static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out IntPtr read);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
}
'@
function Get-ProcCwd([int]$procId) {
	try {
		$h = [PwdProbe]::OpenProcess(0x0410, $false, $procId)
		if ($h -eq [IntPtr]::Zero) { return $null }
		$pbi = New-Object PwdProbe+PBI; $rl = 0
		if ([PwdProbe]::NtQueryInformationProcess($h, 0, [ref]$pbi, [Runtime.InteropServices.Marshal]::SizeOf($pbi), [ref]$rl) -ne 0) { [void][PwdProbe]::CloseHandle($h); return $null }
		$peb = $pbi.PebBaseAddress
		$buf = New-Object byte[] 8; $rd = [IntPtr]::Zero
		if (-not [PwdProbe]::ReadProcessMemory($h, [IntPtr]($peb.ToInt64() + 0x38), $buf, 8, [ref]$rd)) { [void][PwdProbe]::CloseHandle($h); return $null }
		$params = [BitConverter]::ToInt64($buf, 0)
		if ($params -le 0) { [void][PwdProbe]::CloseHandle($h); return $null }
		$cwdBuf = New-Object byte[] 16
		if (-not [PwdProbe]::ReadProcessMemory($h, [IntPtr]($params.ToInt64() + 0x38), $cwdBuf, 16, [ref]$rd)) { [void][PwdProbe]::CloseHandle($h); return $null }
		$len = [BitConverter]::ToUInt16($cwdBuf, 0)
		$ptr = [BitConverter]::ToInt64($cwdBuf, 8)
		if ($len -le 0 -or $len -gt 1024) { [void][PwdProbe]::CloseHandle($h); return $null }
		$strBuf = New-Object byte[] $len
		[void][PwdProbe]::ReadProcessMemory($h, [IntPtr]$ptr, $strBuf, $len, [ref]$rd)
		[void][PwdProbe]::CloseHandle($h)
		return [Text.Encoding]::Unicode.GetString($strBuf)
	} catch { return $null }
}
Get-Process | ForEach-Object {
	$c = Get-ProcCwd $_.Id
	if ($c -and ($c -match 'JIDE-dev' -or $c -match 'dev-win-x64')) {
		Write-Output ("{0} pid={1} cwd={2}" -f $_.Name, $_.Id, $c)
	}
}
Write-Output "SCAN_DONE"
