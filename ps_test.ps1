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

    public SessionMonitorForm()
    {
        this.WindowState = FormWindowState.Minimized;
        this.ShowInTaskbar = false;
        var dummy = this.Handle;
        WTSRegisterSessionNotification(this.Handle, NOTIFY_FOR_THIS_SESSION);
        Console.WriteLine("READY");
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_WTSSESSION_CHANGE)
        {
            int reason = m.WParam.ToInt32();
            if (reason == WTS_SESSION_LOCK) Console.WriteLine("LOCKED");
            else if (reason == WTS_SESSION_UNLOCK) Console.WriteLine("UNLOCKED");
        }
        base.WndProc(ref m);
    }
}
"@
# We only want to test compilation on macOS via mono if possible, but we don't have Windows.
