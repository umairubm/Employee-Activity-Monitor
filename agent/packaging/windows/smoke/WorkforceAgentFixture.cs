// This is a deliberately benign test image.  It is not the Workforce Analytics
// agent and must never be used for a release or a device rollout.
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Threading;

#if FIXTURE_VERSION_2
[assembly: AssemblyVersion("2.0.0.0")]
[assembly: AssemblyFileVersion("2.0.0.0")]
[assembly: AssemblyInformationalVersion("2.0.0-smoke-fixture")]
#else
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]
[assembly: AssemblyInformationalVersion("1.0.0-smoke-fixture")]
#endif
[assembly: AssemblyTitle("WorkforceAgent smoke fixture (not the real agent)")]
[assembly: AssemblyDescription("Benign native process used only by the Windows installer smoke harness")]
[assembly: AssemblyCompany("Workforce Analytics smoke tests")]

internal static class Program
{
    private static int Main()
    {
        string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        string directory = Path.Combine(appData, "WorkforceAgent");
        Directory.CreateDirectory(directory);

        // The regular installer writes this seed only after a visible enrollment
        // and consent flow.  Creating a deterministic config here gives the
        // harness a durable byte sequence to compare during the upgrade.
        string config = Path.Combine(directory, "config.json");
        if (!File.Exists(config))
        {
            string seed = Path.Combine(directory, "enroll_seed.json");
            if (!File.Exists(seed))
            {
                return 41;
            }

            File.WriteAllText(
                config,
                "{\r\n  \"fixture_enrolled\": true,\r\n  \"fixture_identity\": \"smoke-only\"\r\n}\r\n");
        }

        bool ownsMutex;
        using (var mutex = new Mutex(true, "Local\\WorkforceAgent-Windows-Smoke-Fixture", out ownsMutex))
        {
            if (!ownsMutex)
            {
                return 42;
            }

            string version = Assembly.GetExecutingAssembly()
                .GetName().Version.ToString();
            string launchLog = Path.Combine(directory, "smoke-fixture-launches.log");
            File.AppendAllText(
                launchLog,
                string.Format(
                    "{0}|{1}|{2:O}{3}",
                    version,
                    Process.GetCurrentProcess().Id,
                    DateTime.UtcNow,
                    Environment.NewLine));

            // A native, windowless process is enough to exercise Inno's process
            // replacement and [Run] behavior.  It intentionally makes no API
            // calls, takes no screenshots, and does not claim a real heartbeat.
            while (true)
            {
                Thread.Sleep(1000);
            }
        }
    }
}