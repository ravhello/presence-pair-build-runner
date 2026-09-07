[CmdletBinding()]
param(
    [string] $SourcePath = (Join-Path $PSScriptRoot '..\..\presence-pair-ios'),
    [string] $Repository = 'ravhello/presence-pair-build-runner'
)

$ErrorActionPreference = 'Stop'
$runnerRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$sourceRoot = [IO.Path]::GetFullPath((Resolve-Path -LiteralPath $SourcePath).Path)
$openssl = 'C:\Program Files\Git\usr\bin\openssl.exe'

if (-not (Test-Path -LiteralPath $openssl -PathType Leaf)) {
    throw "OpenSSL was not found at $openssl"
}
foreach ($command in 'git', 'gh') {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
        throw "Required command not found: $command"
    }
}
if (git -C $sourceRoot status --porcelain) {
    throw 'The private source repository must be clean before packaging.'
}

function Set-GitHubSecret {
    param(
        [Parameter(Mandatory)] [string] $Name,
        [Parameter(Mandatory)] [string] $Value
    )

    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = (Get-Command gh).Source
    $start.UseShellExecute = $false
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in @('secret', 'set', $Name, '--repo', $Repository)) {
        $start.ArgumentList.Add($argument)
    }

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $start
    if (-not $process.Start()) {
        throw 'Could not start GitHub CLI.'
    }
    $process.StandardInput.Write($Value)
    $process.StandardInput.Close()
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
        throw "GitHub secret update failed: $stderr$stdout"
    }
}

$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$tempRoot = [IO.Path]::GetFullPath(
    (Join-Path $tempBase ('presence-pair-package-' + [guid]::NewGuid().ToString('N')))
)
if (-not $tempRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Refusing to use an unexpected temporary path.'
}

$password = $null
New-Item -ItemType Directory -Path $tempRoot | Out-Null
try {
    $sourceZip = Join-Path $tempRoot 'source.zip'
    $encryptedSource = Join-Path $tempRoot 'source.enc'
    $verifiedZip = Join-Path $tempRoot 'verified.zip'

    & git -C $sourceRoot archive --format=zip --output=$sourceZip HEAD
    if ($LASTEXITCODE -ne 0) {
        throw 'git archive failed.'
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($sourceZip)
    try {
        if ($archive.Entries.FullName -notcontains 'project.yml') {
            throw 'project.yml is missing from the source archive.'
        }
    }
    finally {
        $archive.Dispose()
    }

    $randomBytes = [byte[]]::new(48)
    [Security.Cryptography.RandomNumberGenerator]::Fill($randomBytes)
    $password = [Convert]::ToBase64String($randomBytes)
    $env:SOURCE_ARCHIVE_PASSWORD = $password

    & $openssl enc -aes-256-cbc -salt -pbkdf2 -iter 200000 `
        -in $sourceZip -out $encryptedSource -pass env:SOURCE_ARCHIVE_PASSWORD
    if ($LASTEXITCODE -ne 0) {
        throw 'Source encryption failed.'
    }

    & $openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 `
        -in $encryptedSource -out $verifiedZip -pass env:SOURCE_ARCHIVE_PASSWORD
    if ($LASTEXITCODE -ne 0) {
        throw 'Source decryption verification failed.'
    }

    $archiveHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $sourceZip).Hash
    $verifiedHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $verifiedZip).Hash
    if ($archiveHash -ne $verifiedHash) {
        throw 'The decrypted archive does not match the source archive.'
    }

    Set-GitHubSecret -Name 'SOURCE_ARCHIVE_PASSWORD' -Value $password
    Copy-Item -LiteralPath $encryptedSource `
        -Destination (Join-Path $runnerRoot 'source.enc') -Force

    Write-Host "Source commit: $(& git -C $sourceRoot rev-parse HEAD)"
    Write-Host "Archive SHA256: $archiveHash"
    Write-Host "Encrypted SHA256: $((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $runnerRoot 'source.enc')).Hash)"
}
finally {
    Remove-Item Env:SOURCE_ARCHIVE_PASSWORD -ErrorAction SilentlyContinue
    $password = $null
    if (Test-Path -LiteralPath $tempRoot) {
        Remove-Item -LiteralPath $tempRoot -Recurse -Force
    }
}
