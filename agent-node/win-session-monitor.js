import { spawn } from "child_process";
import { EventEmitter } from "events";

export class WindowsSessionMonitor extends EventEmitter {
  constructor() {
    super();
    this.psProc = null;
    this.isLocked = false;
  }

  start() {
    const psCommand = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class SessionMonitorForm : Form
{
    private const int NOTIFY_FOR_THIS_SESSION = 0;
    private const int WM_WTSSESSION_CHANGE = 0x02B1;
    private const int WTS_SESSION_LOCK = 0x7;
    private const int WTS_SESSION_UNLOCK = 0x8;

    [DllImport("wtsapi32.dll", SetLastError = true)]
    private static extern bool WTSRegisterSessionNotification(IntPtr hWnd, int dwFlags);
    
    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);
    
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseDesktop(IntPtr hDesktop);

    public SessionMonitorForm()
    {
        this.WindowState = FormWindowState.Minimized;
        this.ShowInTaskbar = false;
        var dummy = this.Handle;
        WTSRegisterSessionNotification(this.Handle, NOTIFY_FOR_THIS_SESSION);
        
        bool isLocked = true;
        IntPtr hDesktop = OpenInputDesktop(0, false, 0x0100);
        if (hDesktop != IntPtr.Zero) {
            isLocked = false;
            CloseDesktop(hDesktop);
        }
        Console.WriteLine("READY:" + (isLocked ? "LOCKED" : "UNLOCKED"));
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_WTSSESSION_CHANGE)
        {
            int reason = m.WParam.ToInt32();
            if (reason == WTS_SESSION_LOCK) Console.WriteLine("LOCKED");
            else if (reason == WTS_SESSION_UNLOCK) Console.WriteLine("UNLOCKED");
        }
        else if (m.Msg == 0x0218) // WM_POWERBROADCAST
        {
            int powerEvent = m.WParam.ToInt32();
            if (powerEvent == 0x0004) // PBT_APMSUSPEND
            {
                Console.WriteLine("SUSPEND");
            }
            else if (powerEvent == 0x0012 || powerEvent == 0x0007) // PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND
            {
                bool isLocked = true;
                IntPtr hDesktop = OpenInputDesktop(0, false, 0x0100);
                if (hDesktop != IntPtr.Zero) {
                    isLocked = false;
                    CloseDesktop(hDesktop);
                }
                Console.WriteLine(isLocked ? "LOCKED" : "UNLOCKED");
            }
        }
        base.WndProc(ref m);
    }
}
"@
[System.Windows.Forms.Application]::Run([SessionMonitorForm]::new())
`;
    this.psProc = spawn("powershell", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", psCommand]);

    this.psProc.stdout.on("data", (data) => {
      const output = data.toString().trim();
      if (output.includes("READY:LOCKED")) {
          this.isLocked = true;
      } else if (output.includes("READY:UNLOCKED")) {
          this.isLocked = false;
      } else if (output.includes("LOCKED")) {
          this.isLocked = true;
          this.emit("lock");
      } else if (output.includes("UNLOCKED")) {
          this.isLocked = false;
          this.emit("unlock");
      } else if (output.includes("SUSPEND")) {
          this.emit("suspend");
      }
    });

    this.psProc.stderr.on("data", (data) => {
      console.error("[SessionMonitor PS Error]", data.toString());
    });
  }

  stop() {
    if (this.psProc) {
      this.psProc.kill();
      this.psProc = null;
    }
  }
}
