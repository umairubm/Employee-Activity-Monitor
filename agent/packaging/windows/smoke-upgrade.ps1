# Run only on a disposable, unlocked Windows desktop as a non-admin user.
# This script intentionally does not elevate, import trust roots, change execution
# policy, add antivirus exclusions, or change UAC/Defender/firewall configuration.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$BaselineInstaller,
    [Parameter(Mandatory)][string]$BaselineVersion,
    [Parameter(Mandatory)][string]$CandidateInstaller,
    [Parameter(Mandatory)][string]$CandidateAgent,
    [Parameter(Mandatory)][string]$CandidateVersion,
    [Parameter(Mandatory)][string]$UnsignedInstaller,
    [Parameter(Mandatory)][string]$WrongPublisherInstaller,
    [Parameter(Mandatory)][string]$ExpectedPublisher,
    [Parameter(Mandatory)][string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$BaselineInstaller = (Resolve-Path -LiteralPath $BaselineInstaller).Path
$CandidateInstaller = (Resolve-Path -LiteralPath $CandidateInstaller).Path
$CandidateAgent = (Resolve-Path -LiteralPath $CandidateAgent).Path
$UnsignedInstaller = (Resolve-Path -LiteralPath $UnsignedInstaller).Path
$WrongPublisherInstaller = (Resolve-Path -LiteralPath $WrongPublisherInstaller).Path
$null = New-Item -ItemType Directory -Force -Path $OutputDirectory
$preflight = [ordered]@{ status = 'failed'; stage = 'preflight' }
try {
    if ($env:OS -ne 'Windows_NT') { throw 'Native Windows is required.' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'Run with a normal non-elevated test-user token, never as administrator.'
    }
    if (-not [Environment]::UserInteractive -or (Get-Process -Id $PID).SessionId -eq 0) {
        throw 'An unlocked interactive desktop is required; a runner service is not supported.'
    }
    $uac = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System'
    if ($uac.EnableLUA -ne 1) { throw 'UAC must be enabled before this test can run.' }
    $defender = Get-MpComputerStatus
    if (-not $defender.AMServiceEnabled -or -not $defender.AntivirusEnabled -or
        -not $defender.RealTimeProtectionEnabled) {
        throw 'Use a Windows test image with Defender and real-time protection enabled.'
    }
    if (Test-Path (Join-Path $env:APPDATA 'WorkforceAgent')) {
        throw 'Existing agent data found. Restore a fresh disposable VM; do not reuse an enrolled profile.'
    }
    foreach ($version in @($BaselineVersion, $CandidateVersion)) {
        if ($version -notmatch '^\d+\.\d+\.\d+$') {
            throw 'Use explicit three-part stable baseline and candidate versions.'
        }
    }
    if ([version]$CandidateVersion -le [version]$BaselineVersion) {
        throw 'Candidate must be newer than the signed baseline (no same-version reinstall).'
    }
    foreach ($artifact in @($BaselineInstaller, $CandidateInstaller, $CandidateAgent)) {
        & "$PSScriptRoot/verify-release.ps1" -Path $artifact -ExpectedPublisher $ExpectedPublisher
    }
    & "$PSScriptRoot/verify-release.ps1" -Path $CandidateInstaller -ExpectedPublisher $ExpectedPublisher -VerifyChecksum
    $unsigned = Get-AuthenticodeSignature -LiteralPath (Resolve-Path -LiteralPath $UnsignedInstaller).Path
    if ($unsigned.Status -ne 'NotSigned') { throw 'Unsigned negative fixture must actually be unsigned.' }
    $other = Get-AuthenticodeSignature -LiteralPath (Resolve-Path -LiteralPath $WrongPublisherInstaller).Path
    if ($other.Status -ne 'Valid' -or $null -eq $other.SignerCertificate) {
        throw 'Wrong-publisher fixture must have a genuinely trusted signature, not a tampered/self-signed file.'
    }
    $otherSubject = ($other.SignerCertificate.Subject.Trim() -replace '\s+', ' ')
    if ($otherSubject -ieq ($ExpectedPublisher.Trim() -replace '\s+', ' ')) {
        throw 'Wrong-publisher fixture unexpectedly belongs to the production publisher.'
    }
    # Exercise the Node verifier against real Windows Authenticode too. It never
    # executes fixtures and never injects a mocked signature runner/trust subject.
    & node "$PSScriptRoot/smoke-verifier.mjs" $CandidateAgent $CandidateInstaller $UnsignedInstaller $WrongPublisherInstaller
    if ($LASTEXITCODE -ne 0) { throw 'Native Node Authenticode matrix failed.' }
    $preflight.status = 'passed'
    $preflight.uacEnabled = $true
    $preflight.defenderEnabled = $true
    $preflight.nonElevated = $true
    $preflight.nodeAuthenticodeMatrix = 'passed'
    $preflight.baselineVersion = $BaselineVersion
    $preflight.candidateVersion = $CandidateVersion
    $preflight.candidateSha256 = (Get-FileHash -LiteralPath $CandidateInstaller -Algorithm SHA256).Hash
    $preflight.baselineSha256 = (Get-FileHash -LiteralPath $BaselineInstaller -Algorithm SHA256).Hash
} finally {
    $preflight | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $OutputDirectory 'preflight.json')
}

& python "$PSScriptRoot/smoke/run.py" `
    --baseline $BaselineInstaller --candidate $CandidateInstaller `
    --unsigned $UnsignedInstaller --wrong-publisher $WrongPublisherInstaller `
    --baseline-version $BaselineVersion --candidate-version $CandidateVersion `
    --output (Join-Path $OutputDirectory 'smoke.json')
if ($LASTEXITCODE -ne 0) { throw 'Native installer smoke failed; inspect sanitized smoke.json.' }