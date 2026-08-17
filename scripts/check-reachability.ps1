<#
.SYNOPSIS
  Live Bridge - diagnose why a remote encoder can or cannot reach this machine.

.DESCRIPTION
  Walks the four layers between a remote contributor and SRS, and reports which
  one is blocking. Read-only: changes nothing, opens nothing.

    Layer 1  Docker publishes the port on a non-loopback address
    Layer 2  Windows is actually listening on it
    Layer 3  Windows Firewall allows it inbound
    Layer 4  The router forwards it from the WAN   <- cannot be tested from here

  Layer 4 genuinely cannot be verified from inside the network: a packet sent
  from this PC to its own public IP is handled by the router locally (or dropped)
  and never traverses the WAN path a real contributor takes. Use -External to
  have a third-party service probe the TCP port from outside instead.

.PARAMETER External
  Ask an external service to probe TCP 1935 from the internet. This discloses
  your public IP and port to that third party. Off by default. There is no
  equivalent free UDP probe, so SRT/9000 still needs a real remote test.
#>
[CmdletBinding()]
param([switch]$External)

$ErrorActionPreference = 'Continue'
$fail = 0

function Write-Head($t) { Write-Host ''; Write-Host $t -ForegroundColor Cyan; Write-Host ('-' * $t.Length) -ForegroundColor Cyan }
function Pass($t) { Write-Host "  PASS  $t" -ForegroundColor Green }
function Fail($t) { Write-Host "  FAIL  $t" -ForegroundColor Red; $script:fail++ }
function Warn($t) { Write-Host "  WARN  $t" -ForegroundColor Yellow }
function Note($t) { Write-Host "        $t" -ForegroundColor DarkGray }

$root = Split-Path $PSScriptRoot -Parent

Write-Head 'Layer 0 - addresses'
$route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
         Sort-Object RouteMetric | Select-Object -First 1
$lanIp = $null; $gateway = $null
if ($route) {
  $lanIp   = (Get-NetIPAddress -InterfaceIndex $route.ifIndex -AddressFamily IPv4 |
              Where-Object { $_.IPAddress -notlike '169.254.*' } | Select-Object -First 1).IPAddress
  $gateway = $route.NextHop
  Note "LAN IP  : $lanIp"
  Note "gateway : $gateway"
}
$publicIp = $null
try { $publicIp = (Invoke-RestMethod -Uri 'https://api.ipify.org?format=json' -TimeoutSec 10).ip } catch { }
if ($publicIp) {
  Note "public  : $publicIp"
  if ($publicIp -match '^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.') {
    Fail 'Public IP is in the carrier-grade NAT range 100.64.0.0/10.'
    Note 'No router port forward can ever work. You need a public IP from the ISP,'
    Note 'or a relay such as Tailscale or a cloud VPS.'
  }
}

Write-Head 'Layer 1 - Docker publish bindings'
$dockerUp = $true
try { docker ps --format '{{.Names}}' 2>&1 | Out-Null; if ($LASTEXITCODE -ne 0) { $dockerUp = $false } }
catch { $dockerUp = $false }

if (-not $dockerUp) {
  Fail 'Docker is not running - the stack is down, nothing can be reached.'
  Note 'Start Docker Desktop, then: docker compose up -d'
} else {
  $srs = docker ps --filter 'name=livebridge_srs' --format '{{.Ports}}' 2>$null
  if (-not $srs) {
    Fail 'livebridge_srs is not running.'
    Note 'Run: docker compose up -d'
  } else {
    Note "published: $srs"
    foreach ($spec in @(@{p='9000';proto='udp';n='SRT'}, @{p='1935';proto='tcp';n='RTMP'})) {
      if ($srs -match "127\.0\.0\.1:$($spec.p)->") {
        Fail "$($spec.n) is published on 127.0.0.1 only - loopback. No remote encoder can reach it."
        Note "Fix: set $(if($spec.n -eq 'SRT'){'SRT_BIND_ADDR'}else{'RTMP_BIND_ADDR'})=0.0.0.0 in .env, then: docker compose up -d"
      } elseif ($srs -match "0\.0\.0\.0:$($spec.p)->") {
        Pass "$($spec.n) published on 0.0.0.0:$($spec.p)/$($spec.proto)"
      } else {
        Warn "$($spec.n) - could not parse a binding for port $($spec.p)"
      }
    }
  }
}

Write-Head 'Layer 2 - Windows is listening'
$tcp = Get-NetTCPConnection -State Listen -LocalPort 1935 -ErrorAction SilentlyContinue
if ($tcp) { Pass "TCP 1935 listening on $(($tcp.LocalAddress | Sort-Object -Unique) -join ', ')" }
else      { Fail 'TCP 1935 not listening' }

$udp = Get-NetUDPEndpoint -LocalPort 9000 -ErrorAction SilentlyContinue
if ($udp) { Pass "UDP 9000 bound on $(($udp.LocalAddress | Sort-Object -Unique) -join ', ')" }
else      { Fail 'UDP 9000 not bound' }

Write-Head 'Layer 3 - Windows Firewall'
# Queried with netsh, not Get-NetFirewallRule. The cmdlet returns an EMPTY set in
# a non-elevated session on this machine rather than an access error, so using it
# here reported "no rules found" for rules that existed and were enabled - a
# false negative that reads exactly like a real misconfiguration. netsh reads the
# same rules without elevation. Never replace this with Get-NetFirewallRule.
$expected = @(
  @{ Name = 'Live Bridge - SRT ingest (UDP 9000)';  Proto = 'UDP'; Port = '9000' }
  @{ Name = 'Live Bridge - RTMP ingest (TCP 1935)'; Proto = 'TCP'; Port = '1935' }
  @{ Name = 'Live Bridge - Dashboard (TCP 443)';    Proto = 'TCP'; Port = '443'  }
)

foreach ($want in $expected) {
  $out = & netsh advfirewall firewall show rule name="$($want.Name)" 2>&1 | Out-String
  if ($out -notmatch 'Rule Name:') {
    Fail "$($want.Proto)/$($want.Port) - no rule '$($want.Name)'"
    Note 'Run (as administrator): .\scripts\setup-port-forwarding.ps1 -Apply'
    continue
  }
  $enabled = $out -match '(?m)^Enabled:\s*Yes'
  $remote  = if ($out -match '(?m)^RemoteIP:\s*(.+?)\s*$') { $matches[1] } else { 'Any' }
  $scope   = if ($remote -eq 'Any') { 'any' } else { $remote }
  if ($enabled) { Pass "$($want.Proto)/$($want.Port) allowed from $scope  -  $($want.Name)" }
  else          { Fail "$($want.Proto)/$($want.Port) rule exists but is DISABLED  -  $($want.Name)" }
}

Write-Head 'Layer 4 - router forward (WAN)'
Note 'Cannot be tested from inside the LAN. A packet from this PC to your own'
Note 'public IP does not take the path a remote contributor takes.'
if ($gateway) { Note "Check the forward table at http://$gateway" }
Note "Required: UDP 9000 and TCP 1935 -> $lanIp"

if ($External) {
  Write-Head 'Layer 4 - external TCP probe (third party)'
  Warn "This sends your public IP and port 1935 to a third-party service."
  try {
    $body = @{ host = $publicIp; port = 1935 } | ConvertTo-Json
    $resp = Invoke-RestMethod -Uri 'https://portchecker.io/api/v1/query' -Method Post `
              -Body $body -ContentType 'application/json' -TimeoutSec 25
    $open = $false
    if ($resp.check) { $open = [bool]($resp.check | Where-Object { $_.port -eq 1935 -and $_.status }) }
    if ($open) { Pass 'TCP 1935 is OPEN from the internet - the router forward works.' }
    else {
      Fail 'TCP 1935 is CLOSED from the internet.'
      Note 'Either the router forward is missing/wrong, or the ISP blocks it, or CGNAT.'
    }
  } catch {
    Warn "External probe failed: $($_.Exception.Message)"
    Note 'Not evidence either way - the probe service may just be unavailable.'
  }
  Note 'No UDP probe is available, so SRT/9000 still needs a real remote encoder test.'
}

Write-Head 'Summary'
if ($fail -eq 0) {
  Write-Host '  Layers 1-3 are clear. If a remote encoder still cannot connect, the' -ForegroundColor Green
  Write-Host '  router forward (layer 4) or the ISP is the remaining cause.'         -ForegroundColor Green
} else {
  Write-Host "  $fail blocking problem(s) found above - fix those first." -ForegroundColor Red
}
Write-Host ''
# Non-zero exit when a layer is blocking, so this is usable as a gate in a script.
exit ([int]($fail -gt 0))
