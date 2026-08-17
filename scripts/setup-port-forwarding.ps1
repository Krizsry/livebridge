<#
.SYNOPSIS
  Live Bridge - configure Windows Firewall for remote (WAN) contributor ingest,
  and print the exact router port-forward rules to enter by hand.

.DESCRIPTION
  Live Bridge is unreachable from outside this PC by default. Three separate
  layers each block inbound traffic, and ALL THREE must be opened:

    1. Docker publish bind address  ->  .env (SRT_BIND_ADDR / RTMP_BIND_ADDR)
    2. Windows Firewall             ->  this script
    3. Router NAT port forwarding   ->  manual, in the router admin page

  This script does layer 2 and tells you exactly what to type for layer 3.
  It does NOT touch the router, and it does NOT edit .env.

  EXPOSURE MODEL - deliberately asymmetric (project rules 2 and 11):

    9000/udp  SRT ingest    -> INTERNET.  Guarded by the SRT passphrase and by
                               the on_publish stream-key check.
    1935/tcp  RTMP ingest    -> INTERNET.  Guarded by the stream key. RTMP has no
                               transport encryption; the key travels in clear.
    443/tcp   Dashboard      -> LAN ONLY.  There is NO login on the dashboard
                               (requirement 12). Anyone who reached it would get
                               full control of relays and stream keys. It is
                               scoped to LocalSubnet here, and you must NOT add a
                               router forward for it.

.PARAMETER Apply
  Actually create the firewall rules. Without this flag the script only reports
  what it would do and changes nothing.

.PARAMETER Remove
  Delete the Live Bridge firewall rules this script created.

.PARAMETER ExposeDashboardToInternet
  Override the LAN-only dashboard restriction. Refuses to run unless you also
  pass -IAcceptDashboardHasNoLogin. Strongly discouraged.

.PARAMETER IAcceptDashboardHasNoLogin
  Explicit acknowledgement required by -ExposeDashboardToInternet.

.EXAMPLE
  .\scripts\setup-port-forwarding.ps1
  Dry run - shows the plan, changes nothing.

.EXAMPLE
  .\scripts\setup-port-forwarding.ps1 -Apply
  Creates the firewall rules. Requires an elevated PowerShell.
#>
[CmdletBinding()]
param(
  [switch]$Apply,
  [switch]$Remove,
  [switch]$ExposeDashboardToInternet,
  [switch]$IAcceptDashboardHasNoLogin
)

$ErrorActionPreference = 'Stop'
$RulePrefix = 'Live Bridge'

function Write-Head($t) { Write-Host ''; Write-Host $t -ForegroundColor Cyan; Write-Host ('-' * $t.Length) -ForegroundColor Cyan }
function Write-Warn($t) { Write-Host "  ! $t" -ForegroundColor Yellow }
function Write-Ok($t)   { Write-Host "  + $t" -ForegroundColor Green }
function Write-Info($t) { Write-Host "  . $t" }

# --- guard rails ------------------------------------------------------------

if ($ExposeDashboardToInternet -and -not $IAcceptDashboardHasNoLogin) {
  Write-Host ''
  Write-Host 'REFUSING: -ExposeDashboardToInternet needs -IAcceptDashboardHasNoLogin.' -ForegroundColor Red
  Write-Host 'The dashboard has no password. Exposing it to the internet hands anyone'  -ForegroundColor Red
  Write-Host 'who finds your IP full control of stream keys and relay destinations.'    -ForegroundColor Red
  exit 1
}

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)

if (($Apply -or $Remove) -and -not $isAdmin) {
  Write-Host ''
  Write-Host 'This needs an elevated PowerShell (firewall rules require admin).' -ForegroundColor Red
  Write-Host 'Right-click PowerShell -> Run as administrator, then re-run.'      -ForegroundColor Red
  exit 1
}

# --- remove mode ------------------------------------------------------------

if ($Remove) {
  Write-Head 'Removing Live Bridge firewall rules'
  $existing = Get-NetFirewallRule -DisplayName "$RulePrefix*" -ErrorAction SilentlyContinue
  if (-not $existing) { Write-Info 'none found'; exit 0 }
  foreach ($r in $existing) {
    Remove-NetFirewallRule -Name $r.Name
    Write-Ok "removed: $($r.DisplayName)"
  }
  Write-Host ''
  Write-Warn 'Router forwards are NOT removed - delete those in the router admin page too.'
  exit 0
}

# --- discover the network ---------------------------------------------------

Write-Head 'Network'

$route   = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
           Sort-Object RouteMetric | Select-Object -First 1
if (-not $route) { Write-Host 'No default route - is this machine online?' -ForegroundColor Red; exit 1 }

$ipCfg   = Get-NetIPAddress -InterfaceIndex $route.ifIndex -AddressFamily IPv4 |
           Where-Object { $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1
$lanIp   = $ipCfg.IPAddress
$gateway = $route.NextHop
$prefix  = $ipCfg.PrefixLength
$adapter = (Get-NetAdapter -InterfaceIndex $route.ifIndex).Name
$dhcp    = $ipCfg.PrefixOrigin -eq 'Dhcp'

Write-Info "adapter      : $adapter"
Write-Info "LAN IP       : $lanIp/$prefix  ($(if ($dhcp) {'DHCP - see warning below'} else {'static'}))"
Write-Info "gateway      : $gateway"

$publicIp = $null
try { $publicIp = (Invoke-RestMethod -Uri 'https://api.ipify.org?format=json' -TimeoutSec 10).ip } catch { }
if ($publicIp) { Write-Info "public IP    : $publicIp" }
else           { Write-Warn 'public IP    : lookup failed (no internet?)' }

# CGNAT detection. A public IP that is itself in a shared-address range means the
# ISP is NATing you and no router forward can ever work.
if ($publicIp -match '^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.' ) {
  Write-Host ''
  Write-Host 'BLOCKER: your public IP is inside 100.64.0.0/10 (carrier-grade NAT).' -ForegroundColor Red
  Write-Host 'Port forwarding CANNOT work. Ask your ISP for a public/static IP, or'  -ForegroundColor Red
  Write-Host 'use a relay (Tailscale / a cloud VPS) instead.'                        -ForegroundColor Red
}
elseif ($publicIp -match '^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)') {
  Write-Host ''
  Write-Host 'BLOCKER: your public IP is a private address. You are behind another' -ForegroundColor Red
  Write-Host 'layer of NAT. Port forwarding cannot work from here.'                  -ForegroundColor Red
}

if ($dhcp) {
  Write-Host ''
  Write-Warn "This PC's LAN IP came from DHCP and can change on reboot."
  Write-Warn "A router forward points at a fixed IP - reserve $lanIp for this PC"
  Write-Warn "in the router's DHCP settings, or set a static IP, or the forward"
  Write-Warn 'will silently start pointing at the wrong machine.'
}

# --- .env sanity ------------------------------------------------------------

Write-Head 'Stack bind addresses (.env)'

$envPath = Join-Path (Split-Path $PSScriptRoot -Parent) '.env'
$binds = @{}
if (Test-Path $envPath) {
  foreach ($line in Get-Content $envPath) {
    if ($line -match '^\s*(SRT_BIND_ADDR|RTMP_BIND_ADDR|HTTPS_BIND_ADDR|LIVEBRIDGE_PUBLIC_HOST)\s*=\s*(.*?)\s*$') {
      $binds[$matches[1]] = $matches[2]
    }
  }
} else { Write-Warn '.env not found' }

foreach ($k in 'SRT_BIND_ADDR','RTMP_BIND_ADDR') {
  $v = $binds[$k]
  if ($v -eq '0.0.0.0')      { Write-Ok   "$k = $v" }
  elseif ($null -eq $v)      { Write-Warn "$k not set (compose defaults to 0.0.0.0)" }
  else                       { Write-Warn "$k = $v  <- loopback-only; remote encoders CANNOT reach this. Set 0.0.0.0." }
}
$h = $binds['HTTPS_BIND_ADDR']
if ($h -eq '127.0.0.1') { Write-Info "HTTPS_BIND_ADDR = $h  (dashboard on this PC only)" }
else                    { Write-Info "HTTPS_BIND_ADDR = $h  (firewall below scopes it to the LAN)" }

$pub = $binds['LIVEBRIDGE_PUBLIC_HOST']
if ($pub -in @('localhost','127.0.0.1', $null)) {
  Write-Host ''
  Write-Warn "LIVEBRIDGE_PUBLIC_HOST = '$pub'."
  Write-Warn 'The dashboard builds the connection strings it hands to contributors'
  Write-Warn "from this value, so remote users would be told to publish to"
  Write-Warn "'srt://${pub}:9000', which resolves to their own machine and fails."
  Write-Warn 'Set it to your public IP or (better) a DDNS hostname.'
}

# --- firewall plan ----------------------------------------------------------

Write-Head 'Windows Firewall plan'

$rules = @(
  @{ Name = "$RulePrefix - SRT ingest (UDP 9000)";  Proto = 'UDP'; Port = 9000; Scope = 'Any';         Why = 'remote contributor SRT ingest' }
  @{ Name = "$RulePrefix - RTMP ingest (TCP 1935)"; Proto = 'TCP'; Port = 1935; Scope = 'Any';         Why = 'remote contributor RTMP ingest' }
  @{ Name = "$RulePrefix - Dashboard (TCP 443)";    Proto = 'TCP'; Port = 443;  Scope = 'LocalSubnet'; Why = 'dashboard - LAN only, no login exists' }
)

if ($ExposeDashboardToInternet) {
  $rules[2].Scope = 'Any'
  $rules[2].Why   = 'dashboard - INTERNET (override accepted)'
}

foreach ($r in $rules) {
  $scopeText = if ($r.Scope -eq 'Any') { 'any address' } else { 'LAN only' }
  Write-Info ("{0,-5} {1,-5}  {2,-11}  {3}" -f $r.Proto, $r.Port, $scopeText, $r.Why)
}

if (-not $Apply) {
  Write-Host ''
  Write-Warn 'DRY RUN - nothing was changed. Re-run with -Apply (as administrator).'
}
else {
  Write-Host ''
  foreach ($r in $rules) {
    $existing = Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue
    if ($existing) { Remove-NetFirewallRule -DisplayName $r.Name }
    New-NetFirewallRule -DisplayName $r.Name -Direction Inbound -Action Allow `
      -Protocol $r.Proto -LocalPort $r.Port -RemoteAddress $r.Scope `
      -Profile Any -Enabled True -Description $r.Why | Out-Null
    Write-Ok "$($r.Proto)/$($r.Port) allowed ($(if ($r.Scope -eq 'Any') {'any'} else {'LAN'}))"
  }
}

# --- router instructions ----------------------------------------------------

Write-Head "Router port forwarding - do this by hand at http://$gateway"

Write-Host ''
Write-Host '  Add exactly these two rules. Do NOT add one for 443.' -ForegroundColor White
Write-Host ''
Write-Host ('  {0,-10} {1,-10} {2,-14} {3,-12} {4}' -f 'PROTOCOL','EXT PORT','INT IP','INT PORT','NAME')
Write-Host ('  {0,-10} {1,-10} {2,-14} {3,-12} {4}' -f '--------','--------','------','--------','----')
Write-Host ('  {0,-10} {1,-10} {2,-14} {3,-12} {4}' -f 'UDP',  '9000', $lanIp, '9000', 'livebridge-srt')  -ForegroundColor Green
Write-Host ('  {0,-10} {1,-10} {2,-14} {3,-12} {4}' -f 'TCP',  '1935', $lanIp, '1935', 'livebridge-rtmp') -ForegroundColor Green
Write-Host ''
Write-Warn 'SRT is UDP. Routers usually default the protocol dropdown to TCP, and a'
Write-Warn 'TCP forward on 9000 fails silently - the encoder just times out with no'
Write-Warn 'error anywhere in the SRS log. Check that dropdown twice.'
Write-Host ''
Write-Info 'If the router offers "TCP/Both" for 1935 either is fine; RTMP is TCP.'
Write-Info 'If it asks for an "internal/external" pair, keep both the same number.'

Write-Head 'Then verify'
Write-Info '1. Start the stack:   docker compose up -d'
Write-Info '2. Check it listens:  .\scripts\check-reachability.ps1'
Write-Info '3. Have a remote contributor publish to:'
$showHost = if ($pub -and $pub -notin @('localhost','127.0.0.1')) { $pub } elseif ($publicIp) { $publicIp } else { '<your-public-ip>' }
Write-Host ''
Write-Host "     srt://${showHost}:9000?streamid=#!::r=live/<KEY>,m=publish&passphrase=<PASSPHRASE>" -ForegroundColor Green
Write-Host "     rtmp://${showHost}:1935/live/<KEY>" -ForegroundColor Green
Write-Host ''
Write-Warn 'Your home IP is dynamic - it changes. Set up DDNS so contributors keep a'
Write-Warn 'stable hostname. See PORT_FORWARDING.md.'
Write-Host ''
