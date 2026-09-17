param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$ExpectedPublisher,
    [switch]$WriteChecksum,
    [switch]$VerifyChecksum
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($ExpectedPublisher)) {
    throw 'A verified publisher subject must be configured before publishing.'
}
$resolved = (Resolve-Path -LiteralPath $Path).Path
if ($WriteChecksum -and $VerifyChecksum) {
    throw 'Choose checksum creation or verification, not both.'
}
$signature = Get-AuthenticodeSignature -LiteralPath $resolved
if ($signature.Status -ne 'Valid' -or $null -eq $signature.SignerCertificate) {
    throw 'Artifact does not have a valid trusted Authenticode signature.'
}
$actual = ($signature.SignerCertificate.Subject.Trim() -replace '\s+', ' ')
$expected = ($ExpectedPublisher.Trim() -replace '\s+', ' ')
if ($actual -ine $expected) {
    throw 'Artifact publisher does not match the configured production publisher.'
}
if ($null -eq $signature.TimeStamperCertificate) {
    throw 'Artifact must have a trusted timestamp before publishing.'
}
if ($WriteChecksum -or $VerifyChecksum) {
    $hash = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash.ToLowerInvariant()
    $name = [IO.Path]::GetFileName($resolved)
    if ($VerifyChecksum) {
        $sidecar = [IO.File]::ReadAllText("$resolved.sha256").TrimEnd("`r", "`n")
        if ($sidecar -cne "$hash  $name") {
            throw 'Release bytes do not match the post-signing checksum.'
        }
    } else {
        [IO.File]::WriteAllText("$resolved.sha256", "$hash  $name`n", [Text.UTF8Encoding]::new($false))
    }
}
Write-Host 'Verified production signature, publisher, and timestamp.'