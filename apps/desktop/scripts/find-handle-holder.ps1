# Find which process holds an open handle into JIDE-dev (system handle table scan)
$ErrorActionPreference = 'Continue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class HandleScan {
  [DllImport("ntdll.dll")]
  public static extern int NtQuerySystemInformation(int cls, IntPtr buf, int len, out int rl);
  [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(int a, bool inh, int pid);
  [DllImport("kernel32.dll")] public static extern bool DuplicateHandle(IntPtr sp, IntPtr sh, IntPtr dp, out IntPtr dh, uint access, bool inh, uint opt);
  [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] public static extern uint GetFileType(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern uint GetFinalPathNameByHandleW(IntPtr h, System.Text.StringBuilder buf, uint len, uint flags);
}
'@

# SYSTEM_HANDLE_TABLE_ENTRY_INFO (x64): ULONG pid; BYTE type; BYTE flags; USHORT handle; ULONG_PTR object; ULONG access
$entrySize = 24
$len = 0x100000
$buf = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($len)
$rl = 0
$status = [HandleScan]::NtQuerySystemInformation(16, $buf, $len, [ref]$rl)
while ($status -eq -1073741820 -and $len -lt 0x8000000) {
	[System.Runtime.InteropServices.Marshal]::FreeHGlobal($buf)
	$len = $rl + 0x10000
	$buf = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($len)
	$status = [HandleScan]::NtQuerySystemInformation(16, $buf, $len, [ref]$rl)
}
if ($status -ne 0) { Write-Output "QUERY_FAIL status=$status need=$rl"; exit 1 }
$count = [System.Runtime.InteropServices.Marshal]::ReadInt32($buf)
Write-Output "handles=$count"

$results = @()
for ($i = 0; $i -lt $count; $i++) {
	$base = [IntPtr]($buf.ToInt64() + 8 + $i * $entrySize)
	$procId = [System.Runtime.InteropServices.Marshal]::ReadInt32($base)
	$handle = [System.Runtime.InteropServices.Marshal]::ReadInt16($base, 8)
	$access = [System.Runtime.InteropServices.Marshal]::ReadInt32($base, 20)
	if ($procId -eq $PID) { continue }
	$sp = [HandleScan]::OpenProcess(0x0040, $false, $procId)  # PROCESS_DUP_HANDLE
	if ($sp -eq [IntPtr]::Zero) { continue }
	$dh = [IntPtr]::Zero
	if (-not [HandleScan]::DuplicateHandle($sp, [IntPtr]$handle, [IntPtr](-1), [ref]$dh, 0, $false, 2)) { [void][HandleScan]::CloseHandle($sp); continue }  # DUPLICATE_SAME_ACCESS
	[void][HandleScan]::CloseHandle($sp)
	if ([HandleScan]::GetFileType($dh) -ne 1) { [void][HandleScan]::CloseHandle($dh); continue }  # FILE_TYPE_DISK only
	$sb = New-Object System.Text.StringBuilder 1024
	$n = [HandleScan]::GetFinalPathNameByHandleW($dh, $sb, 1024, 0)
	if ($n -gt 0) {
		$path = $sb.ToString()
		if ($path -match 'JIDE-dev') {
			$results += "pid=$procId handle=0x{0:X} access=0x{1:X} path=$path" -f $handle, $access
		}
	}
	[void][HandleScan]::CloseHandle($dh)
}
[System.Runtime.InteropServices.Marshal]::FreeHGlobal($buf)
if ($results.Count -eq 0) { Write-Output "NO-JIDE-DEV-HANDLES" } else { $results | ForEach-Object { Write-Output $_ } }
