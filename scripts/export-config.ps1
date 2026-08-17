<#
.SYNOPSIS
  Live Bridge - export this machine's credentials for migration to a new PC.

.DESCRIPTION
  Writes the handful of values that cannot be regenerated - the Supabase URL and
  service-role key above all - into a bundle that scripts\setup.ps1 can import
  with -ImportConfig. Saves hand-copying a 200-character JWT between machines,
  which is where migrations usually go wrong.

  THE BUNDLE CONTAINS LIVE SECRETS. It is written unencrypted by default because
  it is meant to move over a USB stick or an internal share, not a network. Use
  -Protect to encrypt it with a password instead (AES via DPAPI-independent
  key derivation, so it is portable between machines and Windows accounts).

  Delete the bundle once the new machine is running.

.PARAMETER Path
  Output file. Defaults to livebridge-config.json in the repo root.

.PARAMETER IncludePassphrase
  Also carry the SRT passphrase across, so existing encoders keep working
  without reconfiguration. Omit it and the new machine generates a fresh one.

.PARAMETER Protect
  Encrypt the bundle with a password you will be prompted for.

.EXAMPLE
  .\scripts\export-config.ps1 -IncludePassphrase
  Write livebridge-config.json for the new machine.
#>
[CmdletBinding()]
param(
  [string]$Path,
  [switch]$IncludePassphrase,
  [switch]$Protect
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$envPath = Join-Path $root '.env'
if (-not $Path) { $Path = Join-Path $root 'livebridge-config.json' }

if (-not (Test-Path $envPath)) { Write-Host 'No .env found - nothing to export.' -ForegroundColor Red; exit 1 }

$text = [System.IO.File]::ReadAllText($envPath, [System.Text.Encoding]::UTF8)
function Val($n) {
  $m = [regex]::Match($text, "(?m)^$([regex]::Escape($n))=(.*)$")
  if ($m.Success) { $m.Groups[1].Value.Trim() } else { $null }
}

$keys = @(
  'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
  'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ZONE', 'DDNS_RECORD',
  'LIVEBRIDGE_PUBLIC_HOST'
)
if ($IncludePassphrase) { $keys += 'SRT_PASSPHRASE' }

$bundle = [ordered]@{}
$included = @()
foreach ($k in $keys) {
  $v = Val $k
  # Skip placeholders so the new machine does not inherit "your-token-here".
  if ($v -and $v -notlike 'replace_me*' -and $v -notlike 'your-*' -and $v -notlike '*example.com*') {
    $bundle[$k] = $v
    $included += $k
  }
}

if (-not $included.Count) { Write-Host 'Nothing worth exporting - .env holds only placeholders.' -ForegroundColor Yellow; exit 0 }

$json = $bundle | ConvertTo-Json -Depth 3

if ($Protect) {
  $pw = Read-Host -AsSecureString 'Password to protect the bundle'
  $plainPw = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
              [Runtime.InteropServices.Marshal]::SecureStringToBSTR($pw))
  $salt = New-Object byte[] 16
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($salt)
  $kdf = New-Object System.Security.Cryptography.Rfc2898DeriveBytes($plainPw, $salt, 100000)
  $aes = [System.Security.Cryptography.Aes]::Create()
  $aes.Key = $kdf.GetBytes(32); $aes.GenerateIV()
  $enc = $aes.CreateEncryptor()
  $plain = [Text.Encoding]::UTF8.GetBytes($json)
  $cipher = $enc.TransformFinalBlock($plain, 0, $plain.Length)
  $out = [ordered]@{
    encrypted = $true
    salt      = [Convert]::ToBase64String($salt)
    iv        = [Convert]::ToBase64String($aes.IV)
    data      = [Convert]::ToBase64String($cipher)
  } | ConvertTo-Json
  [System.IO.File]::WriteAllText($Path, $out, (New-Object System.Text.UTF8Encoding($false)))
} else {
  [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

Write-Host ''
Write-Host "  Bundle written: $Path" -ForegroundColor Green
Write-Host "  Contains      : $($included -join ', ')"
Write-Host "  Encrypted     : $(if ($Protect) {'yes'} else {'NO - plain text'})" -ForegroundColor $(if ($Protect) {'Green'} else {'Yellow'})
Write-Host ''
if (-not $Protect) {
  Write-Host '  This file holds live secrets in plain text.' -ForegroundColor Yellow
  Write-Host '  Move it on a USB stick, not over chat or email, and delete it after.' -ForegroundColor Yellow
  Write-Host '  Re-run with -Protect to encrypt it instead.' -ForegroundColor DarkGray
}
Write-Host ''
Write-Host '  On the new machine:' -ForegroundColor Cyan
Write-Host "    .\scripts\setup.ps1 -Apply -ImportConfig .\$(Split-Path $Path -Leaf)"
Write-Host ''
