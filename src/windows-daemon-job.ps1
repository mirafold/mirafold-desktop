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
using System.Text;
using System.Threading;

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

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool TerminateJobObject(IntPtr job, UInt32 exitCode);
  }

  public sealed class JobStopRegistration : IDisposable {
    private readonly EventWaitHandle stopEvent;
    private readonly RegisteredWaitHandle registration;

    public JobStopRegistration(IntPtr job, string eventName) {
      stopEvent = new EventWaitHandle(false, EventResetMode.ManualReset, eventName);
      registration = ThreadPool.RegisterWaitForSingleObject(
        stopEvent,
        (state, timedOut) => JobObjectNative.TerminateJobObject((IntPtr)state, 0),
        job,
        Timeout.Infinite,
        true
      );
    }

    public void Dispose() {
      registration.Unregister(null);
      stopEvent.Dispose();
    }
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public UInt32 cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public UInt32 dwX;
    public UInt32 dwY;
    public UInt32 dwXSize;
    public UInt32 dwYSize;
    public UInt32 dwXCountChars;
    public UInt32 dwYCountChars;
    public UInt32 dwFillAttribute;
    public UInt32 dwFlags;
    public UInt16 wShowWindow;
    public UInt16 cbReserved2;
    public IntPtr lpReserved2;
    public IntPtr hStdInput;
    public IntPtr hStdOutput;
    public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION {
    public IntPtr hProcess;
    public IntPtr hThread;
    public UInt32 dwProcessId;
    public UInt32 dwThreadId;
  }

  public static class JobObjectProcessLauncher {
    private const UInt32 CREATE_SUSPENDED = 0x00000004;
    private const UInt32 STARTF_USESTDHANDLES = 0x00000100;
    private const UInt32 INFINITE = 0xffffffff;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcess(
      string applicationName,
      StringBuilder commandLine,
      IntPtr processAttributes,
      IntPtr threadAttributes,
      [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
      UInt32 creationFlags,
      IntPtr environment,
      string currentDirectory,
      ref STARTUPINFO startupInfo,
      out PROCESS_INFORMATION processInformation
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern UInt32 ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern UInt32 WaitForSingleObject(IntPtr handle, UInt32 milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(IntPtr process, out UInt32 exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(IntPtr process, UInt32 exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetStdHandle(Int32 standardHandle);

    private static string Quote(string value) {
      if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return value;
      var result = new StringBuilder("\"");
      var slashes = 0;
      foreach (var character in value) {
        if (character == '\\') {
          slashes += 1;
        } else if (character == '"') {
          result.Append('\\', slashes * 2 + 1).Append('"');
          slashes = 0;
        } else {
          result.Append('\\', slashes).Append(character);
          slashes = 0;
        }
      }
      result.Append('\\', slashes * 2).Append('"');
      return result.ToString();
    }

    public static Int32 Run(IntPtr job, string executable, string bootstrap, string daemon) {
      var startup = new STARTUPINFO();
      startup.cb = (UInt32)Marshal.SizeOf(startup);
      startup.dwFlags = STARTF_USESTDHANDLES;
      startup.hStdInput = GetStdHandle(-10);
      startup.hStdOutput = GetStdHandle(-11);
      startup.hStdError = GetStdHandle(-12);
      var command = new StringBuilder(
        Quote(executable) + " " + Quote(bootstrap) + " " + Quote(daemon)
      );
      PROCESS_INFORMATION process;
      if (!CreateProcess(
        executable,
        command,
        IntPtr.Zero,
        IntPtr.Zero,
        true,
        CREATE_SUSPENDED,
        IntPtr.Zero,
        null,
        ref startup,
        out process
      )) {
        throw new System.ComponentModel.Win32Exception(
          Marshal.GetLastWin32Error(),
          "Could not create the Mirafold daemon process"
        );
      }

      var resumed = false;
      try {
        bool alreadyAssigned;
        if (!IsProcessInJob(process.hProcess, job, out alreadyAssigned)) {
          throw new System.ComponentModel.Win32Exception(
            Marshal.GetLastWin32Error(),
            "Could not inspect the Mirafold daemon Job assignment"
          );
        }
        if (!alreadyAssigned && !JobObjectNative.AssignProcessToJobObject(job, process.hProcess)) {
          throw new System.ComponentModel.Win32Exception(
            Marshal.GetLastWin32Error(),
            "Could not assign the Mirafold daemon process to its Job Object"
          );
        }
        if (ResumeThread(process.hThread) == 0xffffffff) {
          throw new System.ComponentModel.Win32Exception(
            Marshal.GetLastWin32Error(),
            "Could not resume the Mirafold daemon process"
          );
        }
        resumed = true;
        if (WaitForSingleObject(process.hProcess, INFINITE) == 0xffffffff) {
          throw new System.ComponentModel.Win32Exception(
            Marshal.GetLastWin32Error(),
            "Could not wait for the Mirafold daemon process"
          );
        }
        UInt32 exitCode;
        if (!GetExitCodeProcess(process.hProcess, out exitCode)) {
          throw new System.ComponentModel.Win32Exception(
            Marshal.GetLastWin32Error(),
            "Could not read the Mirafold daemon exit code"
          );
        }
        return unchecked((Int32)exitCode);
      } finally {
        if (!resumed) TerminateProcess(process.hProcess, 1);
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
      }
    }
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

$stopEventName = $env:MIRAFOLD_DESKTOP_WINDOWS_STOP_EVENT
if (-not $stopEventName -or -not $stopEventName.StartsWith("Local\MirafoldDesktopStop-")) {
  throw "Mirafold daemon stop event is missing or invalid"
}
$stopRegistration = [MirafoldDesktop.JobStopRegistration]::new($job, $stopEventName)

# Desktop gives the daemon its own URL deadline only after this wrapper has
# established the kill-on-close boundary and registered graceful shutdown.
# The line is constant and carries no project path, URL, or credential.
[Console]::Out.WriteLine("MIRAFOLD_DESKTOP_WINDOWS_WRAPPER_READY")
[Console]::Out.Flush()

try {
  $exitCode = [MirafoldDesktop.JobObjectProcessLauncher]::Run(
    $job,
    $ElectronExecutable,
    $BootstrapEntry,
    $DaemonEntry
  )
  exit $exitCode
} finally {
  $stopRegistration.Dispose()
}
