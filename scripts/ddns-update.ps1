<#
.SYNOPSIS
  Live Bridge - Cloudflare DDNS updater. Keeps an A record pointed at this
  connection's current public IP so contributors have a stable hostname.

.DESCRIPTION
  Home broadband IPs rotate. Contributors publish to a hostname, this script
  keeps that hostname correct.

  Reads three values from .env (never from the command line, so the token does
  not land in shell history):

    CLOUDFLARE_API_TOKEN   scoped token - Zone:DNS:Edit on this zone ONLY
    CLOUDFLARE_ZONE        krzn.site
    DDNS_RECORD            stream.krzn.site

  IMPORTANT - the record is created and kept as DNS-only (grey cloud), never
  proxied. Cloudflare's HTTP proxy cannot carry SRT (UDP) or RTMP (1935/tcp);
  a proxied record returns Cloudflare's own IPs and breaks ingest completely.
  The script refuses to proxy and warns if it finds an existing record proxied.

  The API token is never printed, and is redacted from any error output.

.PARAMETER Apply
  Actually create or update the record. Without it the script only reports what
  it would do.

.PARAMETER Install
  Register a Scheduled Task that runs this with -Apply every 5 minutes.
  Requires an elevated PowerShell.

.PARAMETER Uninstall
  Remove that Scheduled Task.

.PARAMETER Quiet
  Only emit output when something changed or failed. Used by the task.

.EXAMPLE
  .\scripts\ddns-update.ps1
  Dry run - shows the current record and what it would change.

.EXAMPLE
  .\scripts\ddns-update.ps1 -Apply
  Create or update the record now.

.EXAMPLE
  .\scripts\ddns-update.ps1 -Install
  Keep it updated automatically every 5 minutes.
#>
[CmdletBinding()]
param(
  [switch]$Apply,
  [switch]$Install,
  [switch]$Uninstall,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$TaskName = 'Live Bridge DDNS'
$root     = Split-Path $PSScriptRoot -Parent
$envPath  = Join-Path $root '.env'

function Say($t)  { if (-not $Quiet) { Write-Host $t } }
function Head($t) { if (-not $Quiet) { Write-Host ''; Write-Host $t -ForegroundColor Cyan; Write-Host ('-' * $t.Length) -ForegroundColor Cyan } }
function Ok($t)   { Write-Host "  + $t" -ForegroundColor Green }
function Warn($t) { Write-Host "  ! $t" -ForegroundColor Yellow }
function Bad($t)  { Write-Host "  x $t" -ForegroundColor Red }

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)

# --- scheduled task management ---------------------------------------------

if ($Uninstall) {
  if (-not $isAdmin) { Bad 'Needs an elevated PowerShell.'; exit 1 }
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Ok "removed scheduled task '$TaskName'"
  } else { Say "  . no task named '$TaskName'" }
  exit 0
}

if ($Install) {
  if (-not $isAdmin) { Bad 'Needs an elevated PowerShell (Scheduled Task registration).'; exit 1 }
  $self = Join-Path $PSScriptRoot 'ddns-update.ps1'
  $action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
              -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$self`" -Apply -Quiet"
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
              -RepetitionInterval (New-TimeSpan -Minutes 5)
  $set     = New-ScheduledTaskSettingsSet -StartWhenAvailable `
              -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries `
              -MultipleInstances IgnoreNew
  # SYSTEM so it runs with no one logged in - the server should update its own
  # DNS whether or not the operator is at the desk.
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $set -Principal $principal `
    -Description 'Keeps the Live Bridge ingest hostname pointed at the current public IP.' | Out-Null
  Ok "scheduled task '$TaskName' registered - runs every 5 minutes as SYSTEM"
  Say "  . check it:  Get-ScheduledTaskInfo -TaskName '$TaskName'"
  Say "  . remove it: .\scripts\ddns-update.ps1 -Uninstall"
  exit 0
}

# --- config -----------------------------------------------------------------

if (-not (Test-Path $envPath)) { Bad ".env not found at $envPath"; exit 1 }

$cfg = @{}
foreach ($line in [System.IO.File]::ReadAllLines($envPath)) {
  if ($line -match '^\s*(CLOUDFLARE_API_TOKEN|CLOUDFLARE_ZONE|DDNS_RECORD)\s*=\s*(.*?)\s*$') {
    $cfg[$matches[1]] = $matches[2].Trim('"').Trim("'")
  }
}

$token  = $cfg['CLOUDFLARE_API_TOKEN']
$zone   = $cfg['CLOUDFLARE_ZONE']
$record = $cfg['DDNS_RECORD']

$missing = @()
if (-not $token  -or $token  -like '*your-*' -or $token -like '*changeme*') { $missing += 'CLOUDFLARE_API_TOKEN' }
if (-not $zone   -or $zone   -like '*example*')                            { $missing += 'CLOUDFLARE_ZONE' }
if (-not $record -or $record -like '*example*')                            { $missing += 'DDNS_RECORD' }
if ($missing.Count) {
  Bad "missing or placeholder in .env: $($missing -join ', ')"
  Say ''
  Say '  Add to .env (see PORT_FORWARDING.md section 5):'
  Say '    CLOUDFLARE_API_TOKEN=<token with Zone:DNS:Edit on this zone only>'
  Say '    CLOUDFLARE_ZONE=krzn.site'
  Say '    DDNS_RECORD=stream.krzn.site'
  exit 1
}

# Never let the token reach output, even inside an exception message.
function Hide($text) { if ($token) { "$text" -replace [regex]::Escape($token), '<REDACTED>' } else { "$text" } }

$api  = 'https://api.cloudflare.com/client/v4'
$hdrs = @{ Authorization = "Bearer $token"; 'Content-Type' = 'application/json' }

function Invoke-CF($Method, $Path, $Body) {
  $p = @{ Uri = "$api$Path"; Method = $Method; Headers = $hdrs; TimeoutSec = 25 }
  if ($Body) { $p.Body = ($Body | ConvertTo-Json -Depth 5 -Compress) }
  try { return Invoke-RestMethod @p }
  catch {
    $detail = $_.Exception.Message
    try {
      $s = $_.Exception.Response.GetResponseStream()
      $detail = (New-Object System.IO.StreamReader($s)).ReadToEnd()
    } catch { }
    throw (Hide "Cloudflare API $Method $Path failed: $detail")
  }
}

Head "Live Bridge DDNS - $record"

# --- current public IP ------------------------------------------------------

$ip = $null
foreach ($src in 'https://api.ipify.org','https://ifconfig.me/ip','https://icanhazip.com') {
  try { $ip = (Invoke-RestMethod -Uri $src -TimeoutSec 10).ToString().Trim(); if ($ip) { break } } catch { }
}
if (-not $ip -or $ip -notmatch '^\d{1,3}(\.\d{1,3}){3}$') {
  Bad 'could not determine public IP from any source'
  exit 1
}
Say "  . public IP : $ip"

if ($ip -match '^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.') {
  Warn 'This IP is in the carrier-grade NAT range 100.64.0.0/10.'
  Warn 'DNS will be updated, but inbound port forwarding cannot work behind CGNAT.'
}

# --- resolve zone + record --------------------------------------------------

$z = Invoke-CF GET "/zones?name=$zone"
if (-not $z.success -or $z.result.Count -eq 0) {
  Bad "zone '$zone' not found, or the token cannot see it"
  Say '  The token needs Zone:DNS:Edit AND Zone:Zone:Read on this zone.'
  exit 1
}
$zoneId = $z.result[0].id
Say "  . zone      : $zone"

$r = Invoke-CF GET "/zones/$zoneId/dns_records?type=A&name=$record"
$existing = if ($r.success -and $r.result.Count -gt 0) { $r.result[0] } else { $null }

if ($existing) {
  Say "  . record    : A $record -> $($existing.content)  (proxied=$($existing.proxied), ttl=$($existing.ttl))"
  if ($existing.proxied) {
    Warn 'This record is PROXIED (orange cloud). SRT and RTMP CANNOT pass through'
    Warn 'the Cloudflare proxy - it only carries HTTP/HTTPS. Ingest will fail.'
    Warn 'This script will set it to DNS-only.'
  }
  if ($existing.content -eq $ip -and -not $existing.proxied) {
    Say ''
    if (-not $Quiet) { Ok 'already correct - nothing to do' }
    exit 0
  }
} else {
  Say "  . record    : does not exist yet"
}

# --- apply ------------------------------------------------------------------

$body = @{
  type    = 'A'
  name    = $record
  content = $ip
  ttl     = 60      # short, so a rotation propagates fast; 60 is Cloudflare's floor
  proxied = $false  # MUST stay false - see the note at the top of this file
  comment = 'Live Bridge ingest - DNS-only, required for SRT/RTMP'
}

if (-not $Apply) {
  Say ''
  Warn 'DRY RUN - nothing changed.'
  if ($existing) { Say "  Would set $record -> $ip (DNS-only, ttl 60)" }
  else           { Say "  Would create A $record -> $ip (DNS-only, ttl 60)" }
  Say '  Re-run with -Apply.'
  exit 0
}

if ($existing) {
  $res = Invoke-CF PUT "/zones/$zoneId/dns_records/$($existing.id)" $body
  $verb = 'updated'
} else {
  $res = Invoke-CF POST "/zones/$zoneId/dns_records" $body
  $verb = 'created'
}

if (-not $res.success) { Bad (Hide "API rejected the change: $($res.errors | ConvertTo-Json -Compress)"); exit 1 }

# Always print on a real change, even under -Quiet, so the task leaves a trail.
Write-Host ("[{0}] DDNS {1}: {2} -> {3} (DNS-only)" -f (Get-Date -Format 's'), $verb, $record, $ip) -ForegroundColor Green

if (-not $Quiet) {
  Say ''
  Say '  Next:'
  Say "    1. Set LIVEBRIDGE_PUBLIC_HOST=$record in .env, then: docker compose up -d"
  Say "    2. Keep it current:  .\scripts\ddns-update.ps1 -Install   (elevated)"
  Say "    3. Contributors publish to srt://${record}:9000"
}
exit 0
