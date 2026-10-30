import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
const exec = promisify(execFile);
export type Presence = {
  available: boolean;
  locked: boolean;
  idleMs: number;
  source: string;
  reason?: string;
  sampledAt?: number;
};
export function windowsShell() {
  return (
    process.env.VEGA_POWERSHELL ||
    (process.env.PATH || "")
      .split(";")
      .map((path) => resolve(path, "pwsh.exe"))
      .find(existsSync) ||
    "powershell.exe"
  );
}
// Read-only OS metadata. No desktop activation, synthetic input or UI automation.
const windowsScript = `$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;using System.Runtime.InteropServices;using System.Text;
public static class VegaPresence {
 [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO {public uint cbSize;public uint dwTime;}
 [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
 [DllImport("user32.dll",SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr handle,int index,StringBuilder name,uint length,out uint needed);
 [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr handle);
 public static long Idle(){var info=new LASTINPUTINFO();info.cbSize=(uint)Marshal.SizeOf(info);if(!GetLastInputInfo(ref info))return -1;return (uint)((uint)Environment.TickCount-info.dwTime);}
 public static bool Locked(){var desktop=OpenInputDesktop(0,false,1);if(desktop==IntPtr.Zero)return true;try{var name=new StringBuilder(256);uint needed;if(!GetUserObjectInformation(desktop,2,name,512,out needed))return true;return !String.Equals(name.ToString(),"Default",StringComparison.OrdinalIgnoreCase);}finally{CloseDesktop(desktop);}}
}
'@
$sampled=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();$idle=[VegaPresence]::Idle();[pscustomobject]@{sampledAt=$sampled;available=($idle -ge 0);locked=[VegaPresence]::Locked();idleMs=[Math]::Max(0,$idle);source='win32'}|ConvertTo-Json -Compress`;
export function linuxPresence(text: string, now = Date.now()): Presence {
  const values = Object.fromEntries(
    text
      .trim()
      .split("\n")
      .map((line) => line.split("=")),
  );
  if (!("LockedHint" in values) || !("IdleHint" in values))
    return {
      available: false,
      locked: true,
      idleMs: 0,
      source: "loginctl",
      reason: "Session idle/lock hints unavailable",
    };
  return {
    available: true,
    locked: values.LockedHint === "yes",
    idleMs:
      values.IdleHint === "yes"
        ? Math.max(0, now - Number(values.IdleSinceHint || 0) / 1000)
        : 0,
    source: "loginctl",
  };
}
export async function systemPresence(): Promise<Presence> {
  try {
    if (process.platform === "win32") {
      const { stdout } = await exec(
        windowsShell(),
        ["-NoProfile", "-NonInteractive", "-Command", windowsScript],
        { timeout: 6000, maxBuffer: 65536, windowsHide: true },
      );
      const value = JSON.parse(stdout);
      if (typeof value.idleMs !== "number" || typeof value.locked !== "boolean")
        throw Error("Invalid system presence response");
      return value;
    }
    if (process.platform === "darwin") {
      const [idle, lock] = await Promise.all([
        exec("/usr/sbin/ioreg", ["-r", "-n", "IOHIDSystem", "-d", "1"], {
          timeout: 3000,
          maxBuffer: 65536,
        }),
        exec(
          "/usr/bin/osascript",
          [
            "-l",
            "JavaScript",
            "-e",
            "ObjC.import('CoreGraphics'); var s=ObjC.deepUnwrap($.CGSessionCopyCurrentDictionary()); JSON.stringify({locked:!!s.CGSSessionScreenIsLocked});",
          ],
          { timeout: 3000, maxBuffer: 65536 },
        ),
      ]);
      const ns = /"HIDIdleTime"\s*=\s*(\d+)/.exec(idle.stdout);
      if (!ns) throw Error("HID idle timer unavailable");
      return {
        available: true,
        locked: JSON.parse(lock.stdout).locked,
        idleMs: Number(ns[1]) / 1000000,
        source: "IOHIDSystem/CGSession",
      };
    }
    const session = process.env.XDG_SESSION_ID;
    if (!session) throw Error("No graphical login session");
    const { stdout } = await exec(
      "loginctl",
      [
        "show-session",
        session,
        "-p",
        "IdleHint",
        "-p",
        "LockedHint",
        "-p",
        "IdleSinceHint",
      ],
      { timeout: 3000, maxBuffer: 65536 },
    );
    return linuxPresence(stdout);
  } catch (e: any) {
    return {
      available: false,
      locked: true,
      idleMs: 0,
      source: process.platform,
      reason: "Cannot read OS idle/lock state; computer tasks remain queued",
    };
  }
}
