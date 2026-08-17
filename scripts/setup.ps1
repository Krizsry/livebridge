<#
.SYNOPSIS
  Live Bridge - one-command setup for a new Windows machine.

.DESCRIPTION
  Takes a fresh checkout to a running stack. Idempotent: safe to re-run, and it
  never overwrites secrets or a certificate that already exist.

  Assumes prerequisites are already installed (Docker Desktop, WSL2, and
  optionally NDI/GStreamer). Run scripts\install-windows.ps1 first if not.

  Steps:
    1. Preflight        - Docker installed, engine reachable, compose file present
    2. .env             - created from .env.example if missing
    3. Secrets          - SRT passphrase generated natively (no bash/openssl needed)
    4. Supabase         - imported from a bundle, prompted for, or skipped
    5. TLS certificate  - self-signed, generated natively if absent
    6. Bind addresses   - loopback (default) or LAN/WAN exposure
    7. Firewall         - delegated to setup-port-forwarding.ps1 (opt-in)
    8. Start            - docker compose up -d
    9. Verify           - health checks, then next steps

  DRY RUN BY DEFAULT. Nothing is written or started without -Apply.

.PARAMETER Apply
  Actually make changes. Without it the script only reports what it would do.

.PARAMETER ImportConfig
  Path to a bundle written by scripts\export-config.ps1 on the old machine.
  Carries the Supabase credentials and (optionally) the SRT passphrase over.

.PARAMETER Expose
  Bind address policy for the published ports:
    local  - 127.0.0.1, this PC only (default; safest)
    lan    - 0.0.0.0, reachable from the local network
    wan    - 0.0.0.0 for ingest, and prints the router steps. Dashboard stays
             LAN-scoped regardless - it has no login.

.PARAMETER SkipFirewall
  Do not touch Windows Firewall even when -Expose is lan/wan.

.EXAMPLE
  .\scripts\setup.ps1
  Dry run - shows exactly what it would do.

.EXAMPLE
  .\scripts\setup.ps1 -Apply
  Set up and start, bound to loopback.

.EXAMPLE
  .\scripts\setup.ps1 -Apply -ImportConfig .\livebridge-config.json -Expose wan
  Migrate from another machine and open ingest to the internet.
#>
[CmdletBinding()]
param(
  [switch]$Apply,
  [string]$ImportConfig,
  [ValidateSet('local','lan','wan')][string]$Expose = 'local',
  [switch]$SkipFirewall
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$envPath     = Join-Path $root '.env'
$examplePath = Join-Path $root '.env.example'
$certDir     = Join-Path $root 'nginx\certs'

$script:Changes = @()
$script:Problems = @()

function Step($m) { Write-Host ''; Write-Host "=== $m ===" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  [OK]    $m" -ForegroundColor Green }
function Add($m)  { Write-Host "  [DO]    $m" -ForegroundColor Yellow; $script:Changes += $m }
function Skip($m) { Write-Host "  [SKIP]  $m" -ForegroundColor DarkGray }
function Warn($m) { Write-Host "  [WARN]  $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "  [FAIL]  $m" -ForegroundColor Red; $script:Problems += $m }

# Read/write .env as UTF-8 without BOM. PowerShell 5.1's Get-Content/Set-Content
# default to ANSI and would mangle any non-ASCII byte in the file.
function Read-EnvText { [System.IO.File]::ReadAllText($envPath, [System.Text.Encoding]::UTF8) }
function Write-EnvText($t) { [System.IO.File]::WriteAllText($envPath, $t, (New-Object System.Text.UTF8Encoding($false))) }
function Get-EnvVal($text, $name) {
  $m = [regex]::Match($text, "(?m)^$([regex]::Escape($name))=(.*)$")
  if ($m.Success) { $m.Groups[1].Value.Trim() } else { $null }
}
function Set-EnvVal($text, $name, $value) {
  if ([regex]::IsMatch($text, "(?m)^$([regex]::Escape($name))=")) {
    [regex]::Replace($text, "(?m)^$([regex]::Escape($name))=.*$", "$name=$value")
  } else {
    $text.TrimEnd("`r","`n") + "`n$name=$value`n"
  }
}
function New-HexSecret([int]$bytes = 16) {
  $b = New-Object byte[] $bytes
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  ($b | ForEach-Object { $_.ToString('x2') }) -join ''
}

Write-Host ''
Write-Host 'Live Bridge - setup' -ForegroundColor White
Write-Host "  repo    : $root"
Write-Host "  mode    : $(if ($Apply) { 'APPLY' } else { 'DRY RUN (nothing will change)' })"
Write-Host "  expose  : $Expose"

# =============================================================================
Step '1. Preflight'
# =============================================================================

if (-not (Test-Path $examplePath)) { Fail '.env.example missing - is this a full checkout?' }
else { Ok '.env.example present' }

if (-not (Test-Path (Join-Path $root 'docker-compose.yml'))) { Fail 'docker-compose.yml missing' }
else { Ok 'docker-compose.yml present' }

$dockerCli = Get-Command docker -ErrorAction SilentlyContinue
if (-not $dockerCli) {
  Fail 'docker CLI not found. Run scripts\install-windows.ps1 first.'
} else {
  Ok "docker CLI: $($dockerCli.Source)"
  docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Warn 'Docker engine is not running.'
    # Docker Desktop installs per-user on some machines and is NOT under
    # Program Files, which is why this probes both locations.
    $ddPaths = @(
      "$env:LOCALAPPDATA\Programs\DockerDesktop\Docker Desktop.exe",
      "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
    )
    $dd = $ddPaths | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($dd -and $Apply) {
      Add "start Docker Desktop ($dd)"
      Start-Process -FilePath $dd
      Write-Host '          waiting for the engine (up to 5 min)...' -ForegroundColor DarkGray
      $deadline = (Get-Date).AddMinutes(5)
      while ((Get-Date) -lt $deadline) {
        docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { break }
        Start-Sleep -Seconds 10
      }
      if ($LASTEXITCODE -eq 0) { Ok "engine up: $(docker info --format '{{.ServerVersion}}' 2>$null)" }
      else { Fail 'engine did not start - check the Docker Desktop window for a dialog' }
    } elseif ($dd) {
      Add "start Docker Desktop ($dd)"
    } else {
      Fail 'Docker Desktop not found. Run scripts\install-windows.ps1.'
    }
  } else {
    Ok "engine up: $(docker info --format '{{.ServerVersion}}' 2>$null)"
  }
}

if ($script:Problems.Count) {
  Write-Host ''
  Write-Host 'Preflight failed - fix the above before continuing.' -ForegroundColor Red
  exit 1
}

# =============================================================================
Step '2. .env'
# =============================================================================

$envExisted = Test-Path $envPath
if ($envExisted) {
  Skip ".env already exists - it will be UPDATED IN PLACE, never overwritten"
} else {
  Add 'create .env from .env.example'
  if ($Apply) {
    Copy-Item $examplePath $envPath
    Ok '.env created'
  }
}

if (-not (Test-Path $envPath)) {
  if (-not $Apply) { Write-Host ''; Warn 'DRY RUN - remaining steps assume .env would exist. Re-run with -Apply.'; }
}

$envText = if (Test-Path $envPath) { Read-EnvText } else { [System.IO.File]::ReadAllText($examplePath, [System.Text.Encoding]::UTF8) }

# =============================================================================
Step '3. Secrets'
# =============================================================================

# Generated natively rather than shelling out to scripts/gen-secrets.sh: that
# needs bash + openssl, which is an extra dependency on a fresh Windows box.
# Hex only - the SRS entrypoint sed-substitutes this value into its config, so
# shell/regex metacharacters would corrupt the rendered file.
$pass = Get-EnvVal $envText 'SRT_PASSPHRASE'
$isPlaceholder = (-not $pass) -or ($pass -like 'replace_me*') -or ($pass.Length -lt 10)

if ($isPlaceholder) {
  Add 'generate a new SRT passphrase (32 hex chars, 128 bits)'
  if ($Apply) {
    $envText = Set-EnvVal $envText 'SRT_PASSPHRASE' (New-HexSecret 16)
    Ok 'SRT passphrase generated - read it later with the command in the summary'
  }
} else {
  Skip 'SRT passphrase already set - left untouched (rotating breaks every encoder)'
}

# =============================================================================
Step '4. Supabase'
# =============================================================================

$sbUrl = Get-EnvVal $envText 'SUPABASE_URL'
$sbKey = Get-EnvVal $envText 'SUPABASE_SERVICE_ROLE_KEY'
$sbSet = $sbUrl -and $sbKey -and ($sbUrl -notlike '*your-project*') -and ($sbKey -notlike 'replace_me*')

if ($ImportConfig) {
  if (-not (Test-Path $ImportConfig)) {
    Fail "import bundle not found: $ImportConfig"
  } else {
    Add "import Supabase credentials from $ImportConfig"
    if ($Apply) {
      $bundle = Get-Content $ImportConfig -Raw | ConvertFrom-Json
      foreach ($k in 'SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','SRT_PASSPHRASE','CLOUDFLARE_API_TOKEN','CLOUDFLARE_ZONE','DDNS_RECORD','LIVEBRIDGE_PUBLIC_HOST') {
        $v = $bundle.$k
        if ($v) { $envText = Set-EnvVal $envText $k $v }
      }
      Ok 'credentials imported (values not printed)'
      $sbSet = $true
    }
  }
} elseif ($sbSet) {
  Skip 'Supabase already configured'
} else {
  Warn 'Supabase is NOT configured.'
  Write-Host '          Live streaming, the dashboard and ingest all work without it.' -ForegroundColor DarkGray
  Write-Host '          Only session history and persisted config need it (requirement 21).' -ForegroundColor DarkGray
  Write-Host '          Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to .env later,' -ForegroundColor DarkGray
  Write-Host '          or re-run with -ImportConfig from the old machine.' -ForegroundColor DarkGray
}

# =============================================================================
Step '5. TLS certificate'
# =============================================================================

$crt = Join-Path $certDir 'livebridge.crt'
$key = Join-Path $certDir 'livebridge.key'

if ((Test-Path $crt) -and (Test-Path $key)) {
  Skip 'certificate already present'
} else {
  Add 'generate a self-signed TLS certificate (nginx will not start without one)'
  if ($Apply) {
    if (-not (Test-Path $certDir)) { New-Item -ItemType Directory -Path $certDir -Force | Out-Null }
    $cn = Get-EnvVal $envText 'LIVEBRIDGE_HOST'
    if (-not $cn) { $cn = 'localhost' }

    # nginx needs PEM, and there is no single way to produce it on every Windows
    # PowerShell. RSA.ExportPkcs8PrivateKey() exists only on .NET Core 3.0+
    # (PowerShell 7); PowerShell 5.1 ships .NET Framework, where the method is
    # absent and the call fails at runtime. So: openssl when available (Git for
    # Windows provides it, and install-windows.ps1 installs Git), native export
    # otherwise.
    $openssl = (Get-Command openssl -ErrorAction SilentlyContinue).Source
    if (-not $openssl) {
      $gitSsl = @(
        "$env:ProgramFiles\Git\usr\bin\openssl.exe",
        "${env:ProgramFiles(x86)}\Git\usr\bin\openssl.exe",
        "$env:LOCALAPPDATA\Programs\Git\usr\bin\openssl.exe"
      ) | Where-Object { Test-Path $_ } | Select-Object -First 1
      if ($gitSsl) { $openssl = $gitSsl }
    }

    $canNative = $PSVersionTable.PSVersion.Major -ge 6

    if ($openssl) {
      & $openssl req -x509 -nodes -newkey rsa:2048 -days 730 `
        -keyout $key -out $crt -subj "/CN=$cn/O=Live Bridge" `
        -addext "subjectAltName=DNS:$cn,DNS:localhost" 2>$null
      if ((Test-Path $crt) -and (Test-Path $key)) { Ok "certificate generated with openssl for CN=$cn (self-signed - browsers will warn)" }
      else { Fail 'openssl failed to write the certificate' }
    }
    elseif ($canNative) {
      $cert = New-SelfSignedCertificate -Subject "CN=$cn" -DnsName $cn, 'localhost' `
                -KeyAlgorithm RSA -KeyLength 2048 -NotAfter (Get-Date).AddYears(2) `
                -CertStoreLocation 'Cert:\CurrentUser\My' -KeyExportPolicy Exportable
      try {
        $certB64 = [Convert]::ToBase64String($cert.RawData, 'InsertLineBreaks')
        [System.IO.File]::WriteAllText($crt, "-----BEGIN CERTIFICATE-----`n$certB64`n-----END CERTIFICATE-----`n", (New-Object System.Text.ASCIIEncoding))
        $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPrivateKey($cert)
        $keyB64 = [Convert]::ToBase64String($rsa.ExportPkcs8PrivateKey(), 'InsertLineBreaks')
        [System.IO.File]::WriteAllText($key, "-----BEGIN PRIVATE KEY-----`n$keyB64`n-----END PRIVATE KEY-----`n", (New-Object System.Text.ASCIIEncoding))
        Ok "certificate generated natively for CN=$cn (self-signed - browsers will warn)"
      } finally {
        Remove-Item "Cert:\CurrentUser\My\$($cert.Thumbprint)" -Force -ErrorAction SilentlyContinue
      }
    }
    else {
      Fail 'cannot generate a certificate: openssl not found and PowerShell 5.1 cannot export a PEM private key'
      Write-Host '          Install Git for Windows (provides openssl):  winget install Git.Git' -ForegroundColor DarkGray
      Write-Host '          Then re-run this script.' -ForegroundColor DarkGray
    }
  }
}

# =============================================================================
Step '6. Bind addresses'
# =============================================================================

$binds = switch ($Expose) {
  'local' { @{ SRT='127.0.0.1'; RTMP='127.0.0.1'; HTTPS='127.0.0.1' } }
  'lan'   { @{ SRT='0.0.0.0';   RTMP='0.0.0.0';   HTTPS='0.0.0.0'   } }
  'wan'   { @{ SRT='0.0.0.0';   RTMP='0.0.0.0';   HTTPS='0.0.0.0'   } }
}
foreach ($pair in @(@('SRT_BIND_ADDR',$binds.SRT), @('RTMP_BIND_ADDR',$binds.RTMP), @('HTTPS_BIND_ADDR',$binds.HTTPS))) {
  $cur = Get-EnvVal $envText $pair[0]
  if ($cur -eq $pair[1]) { Skip "$($pair[0]) already $($pair[1])" }
  else {
    Add "$($pair[0]): $cur -> $($pair[1])"
    if ($Apply) { $envText = Set-EnvVal $envText $pair[0] $pair[1] }
  }
}
if ($Expose -ne 'local') {
  Warn 'The dashboard has NO login. It is bound to 0.0.0.0 but the firewall rule'
  Warn 'scopes 443 to the local subnet, and you must never forward 443 on the router.'
}

if ($Apply -and (Test-Path $envPath)) { Write-EnvText $envText; Ok '.env written' }

# =============================================================================
Step '7. Windows Firewall'
# =============================================================================

if ($Expose -eq 'local') {
  Skip 'not needed for -Expose local (nothing is reachable off this PC)'
} elseif ($SkipFirewall) {
  Skip 'skipped by -SkipFirewall'
} else {
  $fw = Join-Path $PSScriptRoot 'setup-port-forwarding.ps1'
  Add 'create firewall rules (UDP 9000, TCP 1935 open; TCP 443 LAN-only)'
  Write-Host "          run in an ELEVATED PowerShell:  $fw -Apply" -ForegroundColor DarkGray
  Write-Host '          (not run from here - it needs elevation of its own)' -ForegroundColor DarkGray
}

# =============================================================================
Step '8. Start the stack'
# =============================================================================

if (-not $Apply) {
  Add 'docker compose up -d --build'
} else {
  Write-Host '  building and starting (first run pulls images - can take several minutes)...' -ForegroundColor DarkGray
  docker compose --project-directory $root up -d --build 2>&1 | Select-Object -Last 6 | ForEach-Object { Write-Host "          $_" -ForegroundColor DarkGray }
  Start-Sleep -Seconds 8
  $running = (docker compose --project-directory $root ps --format '{{.Name}} {{.Status}}' 2>$null)
  if ($running) { Ok "containers:`n$($running -split "`n" | ForEach-Object { "            $_" } | Out-String)".TrimEnd() }
  else { Fail 'no containers running - check: docker compose logs' }
}

# =============================================================================
Step '9. Verify'
# =============================================================================

if ($Apply) {
  $health = & curl.exe -sk -o NUL -w '%{http_code}' https://localhost/api/health 2>$null
  if ($health -eq '200') { Ok 'https://localhost/api/health -> 200' }
  else { Warn "health endpoint returned '$health' - give it a few seconds and retry, or check docker compose logs" }
}

# =============================================================================
Write-Host ''
Write-Host '=== Summary ===' -ForegroundColor Cyan
# =============================================================================

if (-not $Apply) {
  Write-Host ''
  Write-Host "  DRY RUN - $($script:Changes.Count) change(s) would be made. Nothing was written." -ForegroundColor Yellow
  Write-Host '  Re-run with -Apply to execute.' -ForegroundColor Yellow
} else {
  Write-Host ''
  Write-Host '  Setup complete.' -ForegroundColor Green
  Write-Host ''
  Write-Host '  Dashboard   : https://localhost/   (self-signed cert - the browser warning is expected)'
  Write-Host '  Passphrase  : Select-String -Path .env -Pattern ''^SRT_PASSPHRASE='''
  Write-Host ''
  if ($Expose -eq 'wan') {
    Write-Host '  NEXT - router (this is the part no script can do):' -ForegroundColor Yellow
    Write-Host '    1. .\scripts\setup-port-forwarding.ps1 -Apply   (elevated)'
    Write-Host '    2. Follow ROUTER_SETUP.md - check for CGNAT first, then add the two forwards'
    Write-Host '    3. .\scripts\check-reachability.ps1 -External'
  } elseif ($Expose -eq 'lan') {
    Write-Host '  Reachable from the LAN once the firewall rules are applied.' -ForegroundColor DarkGray
  } else {
    Write-Host '  Bound to loopback - reachable from this PC only.' -ForegroundColor DarkGray
    Write-Host '  Re-run with -Expose lan or -Expose wan to open it up.' -ForegroundColor DarkGray
  }
}

if ($script:Problems.Count) {
  Write-Host ''
  Write-Host "  $($script:Problems.Count) problem(s):" -ForegroundColor Red
  $script:Problems | ForEach-Object { Write-Host "    - $_" -ForegroundColor Red }
  exit 1
}
Write-Host ''
exit 0
