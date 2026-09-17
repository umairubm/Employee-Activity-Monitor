param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$ExpectedPublisher,
    [switch]$WriteChecksum
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($ExpectedPublisher)) {
    throw 'A verified publisher subject must be configured before publishing.'
}
$resolved = (Resolve-Path -LiteralPath $Path).Path
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
if ($WriteChecksum) {
    $hash = (Get-FileHash -LiteralPath $resolved -Algorithm SHA256).Hash.ToLowerInvariant()
    $name = [IO.Path]::GetFileName($resolved)
    [IO.File]::WriteAllText("$resolved.sha256", "$hash  $name`n", [Text.UTF8Encoding]::new($false))
}
Write-Host 'Verified production signature, publisher, and timestamp.'