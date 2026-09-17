/**
 * Authenticode verification for Windows agent self-updates.
 *
 * The unpackaged Node client intentionally cannot establish trust from the
 * signature on node.exe (that is OpenJS, not the Workforce Analytics
 * publisher). A signed WorkforceAgent.exe bootstrap is required first.
 */
import { execFile } from "child_process";
import fs from "fs";
import path from "path";

export class WindowsInstallerVerificationError extends Error {}

const POWERSHELL_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "$s=Get-AuthenticodeSignature -LiteralPath $env:WORKFORCE_VERIFY_FILE",
  "$c=$s.SignerCertificate",
  "$subject=if($c){[string]$c.Subject}else{''}",
  "[pscustomobject]@{Status=[string]$s.Status;Subject=$subject} | ConvertTo-Json -Compress",
].join(";");

function powershellExecutable(platform, env) {
  if (platform !== "win32") return "powershell.exe";
  return path.win32.join(
    env.SystemRoot || env.WINDIR || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function normaliseSubject(subject) {
  return String(subject || "").trim().replace(/\s+/g, " ").toLowerCase();
}

function inspectSignature(
  executable,
  execFileImpl = execFile,
  { platform = process.platform, env = process.env } = {},
) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...env, WORKFORCE_VERIFY_FILE: executable };
    execFileImpl(
      powershellExecutable(platform, env),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        POWERSHELL_SCRIPT,
      ],
      {
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 1024 * 1024,
        env: childEnv,
      },
      (error, stdout) => {
        if (error) {
          reject(
            new WindowsInstallerVerificationError(
              "Windows installer signature inspection failed; install the signed WorkforceAgent.exe manually",
            ),
          );
          return;
        }
        try {
          const data = JSON.parse(String(stdout || "").trim());
          if (!data || typeof data !== "object" || Array.isArray(data)) {
            throw new Error("invalid result");
          }
          resolve(data);
        } catch {
          reject(
            new WindowsInstallerVerificationError(
              "Windows installer signature inspection returned no usable result; install the signed WorkforceAgent.exe manually",
            ),
          );
        }
      },
    );
  });
}

/**
 * Verify a downloaded Windows installer before launching it.
 *
 * The optional expectedPublisherSubject is for an explicitly managed
 * enterprise trust policy. It is never read from the ordinary user-writable
 * tracker config. Otherwise the installed signed WorkforceAgent.exe subject
 * is pinned, allowing certificate renewal without pinning a thumbprint.
 */
export async function verifyWindowsInstaller(
  installerPath,
  {
    installedExecutable = process.execPath,
    expectedPublisherSubject = null,
    platform = process.platform,
    execFileImpl = execFile,
  } = {},
) {
  if (platform !== "win32") {
    throw new WindowsInstallerVerificationError(
      "Windows installer verification is unavailable on this OS",
    );
  }
  const installer = path.resolve(String(installerPath));
  if (
    !fs.existsSync(installer) ||
    !fs.statSync(installer).isFile() ||
    fs.lstatSync(installer).isSymbolicLink()
  ) {
    throw new WindowsInstallerVerificationError(
      "downloaded Windows installer is missing or unsafe",
    );
  }

  let expected = normaliseSubject(expectedPublisherSubject);
  if (!expected) {
    const current = path.resolve(String(installedExecutable));
    // Plain node.exe is signed by OpenJS, not by this vendor. Do not use it as
    // the trust anchor for a Workforce Analytics installer.
    if (path.basename(current).toLowerCase() !== "workforceagent.exe") {
      throw new WindowsInstallerVerificationError(
        "this Windows agent is not a signed WorkforceAgent.exe; install a signed WorkforceAgent.exe manually once before using remote updates",
      );
    }
    const installedSignature = await inspectSignature(current, execFileImpl, {
      platform,
    });
    if (String(installedSignature.Status || "").toLowerCase() !== "valid") {
      throw new WindowsInstallerVerificationError(
        "the installed WorkforceAgent.exe does not have a valid trusted Authenticode signature; install a signed WorkforceAgent.exe manually once before using remote updates",
      );
    }
    expected = normaliseSubject(installedSignature.Subject);
    if (!expected) {
      throw new WindowsInstallerVerificationError(
        "the installed WorkforceAgent.exe has no publisher subject; install a signed WorkforceAgent.exe manually",
      );
    }
  }

  const candidateSignature = await inspectSignature(installer, execFileImpl, {
    platform,
  });
  if (String(candidateSignature.Status || "").toLowerCase() !== "valid") {
    throw new WindowsInstallerVerificationError(
      "downloaded Windows installer is unsigned or not trusted; contact an administrator for a signed WorkforceAgent.exe",
    );
  }
  const candidate = normaliseSubject(candidateSignature.Subject);
  if (!candidate) {
    throw new WindowsInstallerVerificationError(
      "downloaded Windows installer has no publisher subject; contact an administrator for a signed WorkforceAgent.exe",
    );
  }
  if (candidate !== expected) {
    throw new WindowsInstallerVerificationError(
      "downloaded Windows installer publisher does not match the trusted WorkforceAgent publisher; no installer was launched",
    );
  }
  return {
    status: String(candidateSignature.Status),
    subject: String(candidateSignature.Subject),
  };
}
