[CmdletBinding()]
param(
    [string]$ReportPath = (Join-Path ($env:RUNNER_TEMP ?? $env:TEMP) 'workforce-windows-upgrade-smoke.json'),
    [switch]$AllowLocal
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Require-CI {
    if ($AllowLocal) {
        return
    }
    if ($env:GITHUB_ACTIONS -ne 'true' -or $env:CI -ne 'true') {
        throw 'Refusing to touch a local Windows profile. Run on the disposable GitHub-hosted runner (or explicitly pass -AllowLocal).'
    }
}

function Find-Tool([string]$Name, [string[]]$Candidates = @()) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }
    foreach ($candidate in $Candidates) {
        if (Test-Path -LiteralPath $candidate) {
            return $candidate
        }
    }
    throw "Required native tool was not found: $Name"
}

function Add-TrustedCertificate($Certificate) {
    foreach ($storeName in @('Root', 'TrustedPublisher')) {
        $store = New-Object System.Security.Cryptography.X509Certificates.X509Store(
            $storeName, 'CurrentUser')
        $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
        try {
            # Add only the public certificate bytes.  The private key remains in
            # CurrentUser\My and is never exported by this harness.
            $publicOnly = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(
                $Certificate.RawData)
            $store.Add($publicOnly)
        } finally {
            $store.Close()
        }
    }
}

function New-SmokeCertificate([string]$Subject) {
    $certificate = New-SelfSignedCertificate `
        -Subject $Subject `
        -Type CodeSigningCert `
        -KeyAlgorithm RSA `
        -KeyLength 2048 `
        -HashAlgorithm SHA256 `
        -KeyExportPolicy NonExportable `
        -NotAfter (Get-Date).AddHours(8) `
        -CertStoreLocation 'Cert:\CurrentUser\My'
    Add-TrustedCertificate $certificate
    return $certificate
}

function Sign-NativeFile([string]$SignTool, [string]$Path, $Certificate) {
    # This is an ephemeral local trust test, so a network timestamp would add
    # an unrelated dependency.  Production signing/timestamping is covered by
    # the release workflow, not by this disposable certificate.
    & $SignTool sign /fd SHA256 /sha1 $Certificate.Thumbprint $Path
    if ($LASTEXITCODE -ne 0) {
        throw "signtool failed for $Path (exit $LASTEXITCODE)"
    }
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    if ($signature.Status -ne 'Valid') {
        throw "Authenticode did not validate the newly signed file: $Path ($($signature.Status))"
    }
}

function Compile-Fixture(
    [string]$Csc,
    [string]$Source,
    [string]$Output,
    [switch]$VersionTwo
) {
    $defines = if ($VersionTwo) { 'FIXTURE_VERSION_2' } else { 'FIXTURE_VERSION_1' }
    & $Csc /nologo /target:winexe /optimize+ /define:$defines `
        /out:$Output $Source
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $Output)) {
        throw "C# fixture compilation failed: $Output"
    }
}

function Invoke-Inno([string]$Iscc, [string]$WorkingDirectory) {
    Push-Location $WorkingDirectory
    try {
        & $Iscc 'windows\WorkforceAgent.iss'
        if ($LASTEXITCODE -ne 0) {
            throw "Inno Setup compilation failed (exit $LASTEXITCODE)"
        }
    } finally {
        Pop-Location
    }
}

function Invoke-ProcessChecked(
    [string]$FilePath,
    [string[]]$ArgumentList,
    [string]$StdoutPath,
    [string]$StderrPath,
    [int]$TimeoutSeconds = 180
) {
    $process = Start-Process -FilePath $FilePath -ArgumentList $ArgumentList `
        -PassThru -Wait -RedirectStandardOutput $StdoutPath `
        -RedirectStandardError $StderrPath
    if (-not $process) {
        throw "Could not start $FilePath"
    }
    return $process.ExitCode
}

function Wait-ForFixtureProcess([string]$Executable, [int]$ExpectedVersion, [int]$TimeoutSeconds = 30) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $matches = @(Get-CimInstance Win32_Process -Filter "Name = 'WorkforceAgent.exe'" |
            Where-Object { $_.ExecutablePath -and
                ([IO.Path]::GetFullPath($_.ExecutablePath) -ieq [IO.Path]::GetFullPath($Executable)) })
        if ($matches.Count -eq 1) {
            $version = (Get-Item -LiteralPath $Executable).VersionInfo.FileVersion
            if ($version -like "$ExpectedVersion.*") {
                return $matches
            }
        }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    throw "Expected exactly one fixture process version $ExpectedVersion at $Executable"
}

function Stop-FixtureProcesses([string]$Executable) {
    $matches = @(Get-CimInstance Win32_Process -Filter "Name = 'WorkforceAgent.exe'" |
        Where-Object { $_.ExecutablePath -and
            ([IO.Path]::GetFullPath($_.ExecutablePath) -ieq [IO.Path]::GetFullPath($Executable)) })
    foreach ($match in $matches) {
        & "$env:SystemRoot\System32\taskkill.exe" /PID $match.ProcessId /T /F 2>$null | Out-Null
    }
}

function Read-Launches([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) {
        return @()
    }
    return @(Get-Content -LiteralPath $Path | Where-Object { $_.Trim() })
}

Require-CI
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../../../..')).Path
$guid = [Guid]::NewGuid().ToString('N')
$runRoot = Join-Path ($env:RUNNER_TEMP ?? $env:TEMP) "workforce-agent-smoke-$guid"
$worktree = Join-Path $runRoot 'packaging'
$installDir = Join-Path $runRoot 'installed-agent'
$reportDir = Join-Path $runRoot 'reports'
$appData = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'WorkforceAgent'
$launchLog = Join-Path $appData 'smoke-fixture-launches.log'
$configPath = Join-Path $appData 'config.json'
$seedPath = Join-Path $appData 'enroll_seed.json'
$report = [ordered]@{
    harness = 'native-windows-upgrade-smoke'
    fixture = 'benign signed C# fixture; not the production WorkforceAgent'
    checks = [ordered]@{}
    failures = @()
}
$publisherCert = $null
$foreignCert = $null
$createdUninstallKey = $false
$cleanupInstall = $false
$fixtureExe = Join-Path $worktree 'dist\WorkforceAgent.exe'
$fixtureSource = Join-Path $repo 'agent\packaging\windows\smoke\WorkforceAgentFixture.cs'

try {
    New-Item -ItemType Directory -Force -Path $runRoot, $reportDir | Out-Null
    # Refuse collisions rather than copying or deleting a user's enrollment.
    $uninstallKey = 'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\{8E1F4C2A-7B3D-4E9A-9F1C-2A6D5B0E3C71}_is1'
    if ((Test-Path -LiteralPath $appData) -or (Test-Path -LiteralPath $installDir) -or
        (Test-Path -LiteralPath $uninstallKey)) {
        throw 'Smoke harness refused a pre-existing WorkforceAgent profile/install collision.'
    }
    # From this point onward every path being cleaned belongs to this run.  In
    # particular, the finally block must not remove a colliding user's profile.
    $cleanupInstall = $true

    $iscc = Find-Tool 'ISCC.exe' @(
        'C:\Program Files (x86)\Inno Setup 6\ISCC.exe',
        'C:\Program Files\Inno Setup 6\ISCC.exe')
    $csc = Find-Tool 'csc.exe' @(
        'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe',
        'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe')
    $signtool = Find-Tool 'signtool.exe' @(
        (Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\bin' -Filter signtool.exe `
            -Recurse -ErrorAction SilentlyContinue | Sort-Object FullName -Descending |
            Select-Object -First 1).FullName)
    $python = Find-Tool 'python.exe'
    $verifyCli = Join-Path $repo 'agent\packaging\windows\smoke\verify_signatures.py'
    if (-not (Test-Path -LiteralPath $verifyCli)) {
        throw 'The native smoke requires the verification CLI (verify_signatures.py) supplied by the owning agent.'
    }

    Copy-Item -LiteralPath (Join-Path $repo 'agent\packaging') -Destination $runRoot -Recurse
    New-Item -ItemType Directory -Force -Path (Join-Path $worktree 'dist') | Out-Null
    $publisherCert = New-SmokeCertificate "CN=Workforce Windows Smoke Publisher $guid"
    $foreignCert = New-SmokeCertificate "CN=Workforce Windows Smoke Foreign Publisher $guid"

    # Build an actual Inno package twice from the unchanged regular script.
    Compile-Fixture $csc $fixtureSource $fixtureExe
    Sign-NativeFile $signtool $fixtureExe $publisherCert
    Invoke-Inno $iscc $worktree
    $v1Installer = Join-Path $worktree 'dist\WorkforceAgent-Setup-windows.exe'
    $v1Signed = Join-Path $runRoot 'WorkforceAgent-v1-signed.exe'
    Copy-Item $v1Installer $v1Signed
    Sign-NativeFile $signtool $v1Signed $publisherCert

    # A silent fresh install must fail before any enrollment seed is written.
    $freshOut = Join-Path $reportDir 'fresh-silent.stdout.txt'
    $freshErr = Join-Path $reportDir 'fresh-silent.stderr.txt'
    $freshCode = Invoke-ProcessChecked $v1Signed @(
        '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-',
        "/DIR=$installDir") $freshOut $freshErr
    if ($freshCode -eq 0 -or (Test-Path -LiteralPath $configPath) -or
        (Test-Path -LiteralPath $seedPath)) {
        throw 'Silent fresh install unexpectedly succeeded or wrote enrollment data.'
    }
    $report.checks.silent_fresh_install_rejected = $true
    if (Test-Path -LiteralPath $installDir) {
        Remove-Item -LiteralPath $installDir -Recurse -Force
    }

    # The UI driver exercises both required fields and the explicit checkbox.
    $uiReport = Join-Path $reportDir 'interactive-install.json'
    $uiCode = Invoke-ProcessChecked $python @(
        (Join-Path $repo 'agent\packaging\windows\smoke\ui_install.py'),
        '--installer', $v1Signed, '--install-dir', $installDir,
        '--token', 'SMOKE-CONTROLLED-TOKEN', '--name', 'Windows Smoke Fixture',
        '--report', $uiReport) (Join-Path $reportDir 'ui.stdout.txt') `
        (Join-Path $reportDir 'ui.stderr.txt') 180
    if ($uiCode -ne 0) {
        throw "interactive first install failed (exit $uiCode)"
    }
    if (-not (Test-Path -LiteralPath $seedPath) -or -not (Test-Path -LiteralPath $configPath)) {
        throw 'interactive install did not leave both the consent seed and fixture config.'
    }
    $report.checks.gui_enrollment_and_consent = $true
    $beforeConfig = [IO.File]::ReadAllBytes($configPath)
    $launchesBefore = Read-Launches $launchLog
    $installedExe = Join-Path $installDir 'WorkforceAgent.exe'
    [void](Wait-ForFixtureProcess $installedExe 1)
    if ($launchesBefore.Count -ne 1 -or $launchesBefore[0] -notlike '1.0.0.0|*') {
        throw 'first install did not launch exactly one version-1 fixture process.'
    }
    $report.checks.initial_fixture_process = $true

    # Rebuild with only the fixture image changed.  Keep an unsigned copy and a
    # different-publisher copy for the real Python+Node verifier.
    Compile-Fixture $csc $fixtureSource $fixtureExe -VersionTwo
    Sign-NativeFile $signtool $fixtureExe $publisherCert
    Remove-Item -LiteralPath (Join-Path $worktree 'dist\WorkforceAgent-Setup-windows.exe') -Force
    Invoke-Inno $iscc $worktree
    $v2Unsigned = Join-Path $runRoot 'WorkforceAgent-v2-unsigned.exe'
    Copy-Item (Join-Path $worktree 'dist\WorkforceAgent-Setup-windows.exe') $v2Unsigned
    $v2Foreign = Join-Path $runRoot 'WorkforceAgent-v2-foreign.exe'
    Copy-Item $v2Unsigned $v2Foreign
    Sign-NativeFile $signtool $v2Foreign $foreignCert
    $v2Signed = Join-Path $runRoot 'WorkforceAgent-v2-signed.exe'
    Copy-Item $v2Unsigned $v2Signed
    Sign-NativeFile $signtool $v2Signed $publisherCert

    $cliOut = Join-Path $reportDir 'signature-cli.stdout.txt'
    $cliErr = Join-Path $reportDir 'signature-cli.stderr.txt'
    $cliCode = Invoke-ProcessChecked $python @(
        $verifyCli, '--installed', $installedExe, '--installer', $v2Signed,
        '--unsigned', $v2Unsigned, '--foreign', $v2Foreign) $cliOut $cliErr 120
    if ($cliCode -ne 0) {
        throw "Python+Node native signature verification CLI failed (exit $cliCode)"
    }
    $report.checks.authenticode_python_and_node_rejections = $true
    $launchesAtVerification = Read-Launches $launchLog
    if ($launchesAtVerification.Count -ne $launchesBefore.Count) {
        throw 'signature rejection checks changed fixture launches; an unverified installer was launched.'
    }

    $bootBefore = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
    $upgradeReport = Join-Path $reportDir 'silent-upgrade.json'
    $upgradeCode = Invoke-ProcessChecked $python @(
        (Join-Path $repo 'agent\packaging\windows\smoke\silent_upgrade.py'),
        '--installer', $v2Signed, '--install-dir', $installDir,
        '--report', $upgradeReport) (Join-Path $reportDir 'upgrade.stdout.txt') `
        (Join-Path $reportDir 'upgrade.stderr.txt') 240
    if ($upgradeCode -ne 0) {
        throw "silent upgrade was not silent or failed (exit $upgradeCode)"
    }
    $bootAfter = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
    if ([DateTime]$bootAfter -ne [DateTime]$bootBefore) {
        throw 'Windows rebooted during the upgrade; /NORESTART was not honored.'
    }
    $beforeHash = [BitConverter]::ToString(
        [Security.Cryptography.SHA256]::HashData($beforeConfig))
    $afterHash = [BitConverter]::ToString(
        [Security.Cryptography.SHA256]::HashData([IO.File]::ReadAllBytes($configPath)))
    if ($beforeHash -cne $afterHash) {
        throw 'silent upgrade changed the enrolled config bytes.'
    }
    $launchesAfter = Read-Launches $launchLog
    [void](Wait-ForFixtureProcess $installedExe 2)
    if ($launchesAfter.Count -ne ($launchesAtVerification.Count + 1) -or
        $launchesAfter[-1] -notlike '2.0.0.0|*') {
        throw 'silent upgrade did not launch exactly one new version-2 fixture process.'
    }
    $report.checks.silent_upgrade_preserved_config = $true
    $report.checks.silent_upgrade_single_new_fixture = $true
    $report.checks.silent_upgrade_no_setup_windows = $true
    $report.checks.silent_upgrade_no_reboot = $true
    $report.status = 'passed'
}
catch {
    $report.status = 'failed'
    $report.failures += $_.Exception.Message
    throw
}
finally {
    try {
        if ($cleanupInstall) {
            if (Test-Path -LiteralPath $installDir) {
                Stop-FixtureProcesses (Join-Path $installDir 'WorkforceAgent.exe')
            }
            $uninstallKey = 'Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\{8E1F4C2A-7B3D-4E9A-9F1C-2A6D5B0E3C71}_is1'
            if (Test-Path -LiteralPath $uninstallKey) {
                $uninstaller = (Get-ItemProperty -LiteralPath $uninstallKey -Name UninstallString -ErrorAction SilentlyContinue).UninstallString
                if ($uninstaller) {
                    $uninstaller = $uninstaller.Trim('"')
                    Start-Process -FilePath $uninstaller -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART' -Wait `
                        -WindowStyle Hidden -ErrorAction SilentlyContinue
                }
                Remove-Item -LiteralPath $uninstallKey -Recurse -Force -ErrorAction SilentlyContinue
            }
            Remove-Item -LiteralPath $installDir -Recurse -Force -ErrorAction SilentlyContinue
            Remove-Item -LiteralPath $appData -Recurse -Force -ErrorAction SilentlyContinue
        }
        foreach ($certificate in @($publisherCert, $foreignCert)) {
            if ($certificate) {
                foreach ($storeName in @('My', 'Root', 'TrustedPublisher')) {
                    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store(
                        $storeName, 'CurrentUser')
                    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
                    try {
                        $store.Remove($certificate)
                    } finally {
                        $store.Close()
                    }
                }
            }
        }
    } catch {
        $report.failures += "cleanup: $($_.Exception.Message)"
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ReportPath) | Out-Null
    $report | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
}