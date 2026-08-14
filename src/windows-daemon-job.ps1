param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$ElectronExecutable,

  [Parameter(Mandatory = $true, Position = 1)]
  [string]$BootstrapEntry,

  [Parameter(Mandatory = $true, Position = 2)]
  [string]$DaemonEntry
)

$ErrorActionPreference = "Stop"

# The wrapper itself joins a kill-on-close Job Object before it starts
# Electron. Windows then assigns every descendant to the same job by default.
# If Electron crashes after a ConPTY child has detached from its ordinary
# ancestry, this process exits, its last job handle closes, and Windows kills
# everything still in the job.
$jobObjectSource = @"
using System;
using System.Runtime.InteropServices;

namespace MirafoldDesktop {
  [StructLayout(LayoutKind.Sequential)]
  public struct IO_COUNTERS {
    public UInt64 ReadOperationCount;
    public UInt64 WriteOperationCount;
    public UInt64 OtherOperationCount;
    public UInt64 ReadTransferCount;
    public UInt64 WriteTransferCount;
    public UInt64 OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public Int64 PerProcessUserTimeLimit;
    public Int64 PerJobUserTimeLimit;
    public UInt32 LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public UInt32 ActiveProcessLimit;
    public UIntPtr Affinity;
    public UInt32 PriorityClass;
    public UInt32 SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  public static class JobObjectNative {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetInformationJobObject(
      IntPtr job,
      int informationClass,
      IntPtr information,
      UInt32 informationLength
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  }
}
"@

Add-Type -TypeDefinition $jobObjectSource -Language CSharp

$job = [MirafoldDesktop.JobObjectNative]::CreateJobObject([IntPtr]::Zero, $null)
if ($job -eq [IntPtr]::Zero) {
  throw [System.ComponentModel.Win32Exception]::new(
    [Runtime.InteropServices.Marshal]::GetLastWin32Error(),
    "Could not create the Mirafold daemon Job Object"
  )
}

$limits = [MirafoldDesktop.JOBOBJECT_EXTENDED_LIMIT_INFORMATION]::new()
$limits.BasicLimitInformation.LimitFlags = 0x00002000
$limitsSize = [Runtime.InteropServices.Marshal]::SizeOf($limits)
$limitsPointer = [Runtime.InteropServices.Marshal]::AllocHGlobal($limitsSize)
try {
  [Runtime.InteropServices.Marshal]::StructureToPtr($limits, $limitsPointer, $false)
  $configured = [MirafoldDesktop.JobObjectNative]::SetInformationJobObject(
    $job,
    9,
    $limitsPointer,
    $limitsSize
  )
  if (-not $configured) {
    throw [System.ComponentModel.Win32Exception]::new(
      [Runtime.InteropServices.Marshal]::GetLastWin32Error(),
      "Could not configure the Mirafold daemon Job Object"
    )
  }
} finally {
  [Runtime.InteropServices.Marshal]::FreeHGlobal($limitsPointer)
}

$assigned = [MirafoldDesktop.JobObjectNative]::AssignProcessToJobObject(
  $job,
  [System.Diagnostics.Process]::GetCurrentProcess().Handle
)
if (-not $assigned) {
  throw [System.ComponentModel.Win32Exception]::new(
    [Runtime.InteropServices.Marshal]::GetLastWin32Error(),
    "Could not assign the Mirafold daemon wrapper to its Job Object"
  )
}

& $ElectronExecutable $BootstrapEntry $DaemonEntry
exit $LASTEXITCODE
