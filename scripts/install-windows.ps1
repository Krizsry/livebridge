<#
.SYNOPSIS
    Live Bridge - Windows prerequisite installer.

.DESCRIPTION
    Installs and verifies everything Live Bridge needs on a fresh Windows machine:
    WSL2, Docker Desktop, Git, the NDI runtime, GStreamer (with its NDI plugin),
    and the firewall rules for NDI and encoder ingest.

    Idempotent: every step checks first and skips work that is already done, so it
    is safe to re-run after a reboot or a partial failure.

    This installs PREREQUISITES only. It does not start Live Bridge itself -
    see WINDOWS_SETUP.md section 3.5 for `docker compose up -d`.

.PARAMETER SkipNdi
    Skip the NDI runtime, GStreamer and the NDI firewall rules. Use on a machine
    that ingests and relays but produces no NDI output.

.PARAMETER WhatIf
    Report what would be installed without changing anything.

.EXAMPLE
    # From an ELEVATED PowerShell:
    .\scripts\install-windows.ps1

.EXAMPLE
    .\scripts\install-windows.ps1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$SkipNdi
)

$ErrorActionPreference = 'Stop'

# WSL2 needs a reboot before Docker Desktop can start. Tracked so the summary can
# say so plainly rather than leaving the operator to discover it when Docker fails.
$script:RebootRequired = $false
$script:Failures = @()

function Write-Step   { param($m) Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Write-Ok     { param($m) Write-Host "  [OK]   $m" -ForegroundColor Green }
function Write-Skip   { param($m) Write-Host "  [SKIP] $m" -ForegroundColor DarkGray }
function Write-Warn   { param($m) Write-Host "  [WARN] $m" -ForegroundColor Yellow }
function Write-Fail   { param($m) Write-Host "  [FAIL] $m" -ForegroundColor Red; $script:Failures += $m }

# -----------------------------------------------------------------------------
# Preflight
# -----------------------------------------------------------------------------
Write-Step 'Preflight'

$identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    # Not a warning. A non-elevated MSI install fails with exit code 1603 (HKLM
    # denied) after downloading everything - a slow, confusing failure.
    throw 'This script must be run from an ELEVATED PowerShell. Right-click PowerShell -> Run as Administrator.'
}
Write-Ok 'Running elevated'

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw 'winget not found. Install "App Installer" from the Microsoft Store, then re-run.'
}
Write-Ok "winget present: $((Get-Command winget).Source)"

$build = [int](Get-CimInstance Win32_OperatingSystem).BuildNumber
if ($build -lt 19041) {
    throw "Windows build $build is too old for WSL2 (need 19041+). Update Windows first."
}
Write-Ok "Windows build $build supports WSL2"

$ramGb = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
if ($ramGb -lt 16) {
    Write-Warn "$ramGb GB RAM. NDI needs ~400 MB per 1080p stream on top of Docker; 32 GB recommended for 8 streams."
} else {
    Write-Ok "$ramGb GB RAM"
}

# -----------------------------------------------------------------------------
# Helper: install a winget package unless it is already present
# -----------------------------------------------------------------------------
function Install-WingetPackage {
    param(
        [Parameter(Mandatory)][string]$Id,
        [Parameter(Mandatory)][string]$Label,
        [scriptblock]$AlreadyInstalled
    )

    if ($AlreadyInstalled -and (& $AlreadyInstalled)) {
        Write-Skip "$Label already installed"
        return $true
    }

    if (-not $PSCmdlet.ShouldProcess($Label, 'winget install')) { return $true }

    Write-Host "  installing $Label ($Id) ..."
    # --silent so nothing blocks on a GUI; --accept-* so it never waits on a prompt.
    winget install --id $Id --silent --accept-package-agreements --accept-source-agreements | Out-Null

    # winget returns non-zero for "already installed" and other benign states, so
    # trust the capability check over the exit code where we have one.
    if ($AlreadyInstalled -and (& $AlreadyInstalled)) {
        Write-Ok "$Label installed"
        return $true
    }
    if ($LASTEXITCODE -eq 0) { Write-Ok "$Label installed"; return $true }

    Write-Fail "$Label install returned exit code $LASTEXITCODE"
    return $false
}

# -----------------------------------------------------------------------------
# 1. WSL2 - required by Docker Desktop
# -----------------------------------------------------------------------------
Write-Step '1. WSL2'

$wslOk = $false
try {
    $null = wsl.exe --status 2>&1
    $wslOk = ($LASTEXITCODE -eq 0)
} catch { $wslOk = $false }

if ($wslOk) {
    Write-Ok 'WSL is installed'
    wsl.exe --set-default-version 2 2>&1 | Out-Null
    Write-Ok 'Default WSL version set to 2'
} else {
    if ($PSCmdlet.ShouldProcess('WSL2', 'wsl --install')) {
        Write-Host '  installing WSL2 (this enables Windows features) ...'
        wsl.exe --install --no-distribution 2>&1 | Out-Null
        $script:RebootRequired = $true
        Write-Warn 'WSL2 installed - A REBOOT IS REQUIRED before Docker Desktop will start'
    }
}

# -----------------------------------------------------------------------------
# 2. Docker Desktop + Git
# -----------------------------------------------------------------------------
Write-Step '2. Docker Desktop and Git'

Install-WingetPackage -Id 'Docker.DockerDesktop' -Label 'Docker Desktop' -AlreadyInstalled {
    [bool](Get-Command docker -ErrorAction SilentlyContinue)
} | Out-Null

# Git is needed for openssl (self-signed certs) and the bash helper scripts.
Install-WingetPackage -Id 'Git.Git' -Label 'Git for Windows' -AlreadyInstalled {
    [bool](Get-Command git -ErrorAction SilentlyContinue)
} | Out-Null

# -----------------------------------------------------------------------------
# 3. NDI runtime + GStreamer
# -----------------------------------------------------------------------------
if ($SkipNdi) {
    Write-Step '3. NDI (skipped by -SkipNdi)'
} else {
    Write-Step '3. NDI runtime and GStreamer'

    Install-WingetPackage -Id 'NDI.NDIRuntime' -Label 'NDI Runtime' -AlreadyInstalled {
        Test-Path 'C:\Program Files\NDI\*\Processing.NDI.Lib.x64.dll'
    } | Out-Null

    Install-WingetPackage -Id 'gstreamerproject.gstreamer' -Label 'GStreamer' -AlreadyInstalled {
        [bool](Get-Command gst-inspect-1.0 -ErrorAction SilentlyContinue) -or
        (Test-Path 'C:\gstreamer\1.0\msvc_x86_64\bin\gst-inspect-1.0.exe')
    } | Out-Null

    # Put GStreamer on the machine PATH so the NDI agent and these checks find it.
    $gstBin = 'C:\gstreamer\1.0\msvc_x86_64\bin'
    if (Test-Path $gstBin) {
        $machinePath = [Environment]::GetEnvironmentVariable('PATH', 'Machine')
        if ($machinePath -notlike "*$gstBin*") {
            if ($PSCmdlet.ShouldProcess($gstBin, 'add to machine PATH')) {
                [Environment]::SetEnvironmentVariable('PATH', "$machinePath;$gstBin", 'Machine')
                Write-Ok 'GStreamer bin added to machine PATH'
            }
        } else {
            Write-Skip 'GStreamer bin already on PATH'
        }
        $env:PATH = "$env:PATH;$gstBin"
    }
}

# -----------------------------------------------------------------------------
# 4. Firewall
# -----------------------------------------------------------------------------
Write-Step '4. Firewall rules'

function Add-FwRule {
    param($Name, $Protocol, $LocalPort)
    $existing = Get-NetFirewallRule -DisplayName $Name -ErrorAction SilentlyContinue
    if ($existing) { Write-Skip "rule '$Name' exists"; return }
    if (-not $PSCmdlet.ShouldProcess($Name, 'add firewall rule')) { return }
    New-NetFirewallRule -DisplayName $Name -Direction Inbound -Action Allow `
        -Protocol $Protocol -LocalPort $LocalPort -Profile Private,Domain | Out-Null
    Write-Ok "rule '$Name' added ($Protocol/$LocalPort)"
}

# Encoder ingest. Private/Domain profiles only - deliberately NOT Public, so
# plugging into an untrusted network does not expose ingest.
Add-FwRule -Name 'Live Bridge RTMP ingest' -Protocol TCP -LocalPort 1935
Add-FwRule -Name 'Live Bridge SRT ingest'  -Protocol UDP -LocalPort 9000

if (-not $SkipNdi) {
    # NDI: 5353 is mDNS discovery, 5960-5970 is the media/negotiation range.
    Add-FwRule -Name 'NDI discovery' -Protocol UDP -LocalPort 5353
    Add-FwRule -Name 'NDI media'     -Protocol TCP -LocalPort '5960-5970'
}

Write-Warn 'Port 443 (dashboard) is deliberately NOT opened - it has no login. See WINDOWS_SETUP.md section 8.'

# -----------------------------------------------------------------------------
# 5. Verification
# -----------------------------------------------------------------------------
Write-Step '5. Verification'

if (Get-Command docker -ErrorAction SilentlyContinue) {
    $v = (docker --version 2>&1)
    if ($LASTEXITCODE -eq 0) { Write-Ok $v } else { Write-Warn 'docker present but not responding (is Docker Desktop running?)' }
} else {
    Write-Warn 'docker not on PATH yet - reboot or start Docker Desktop'
}

if (-not $SkipNdi) {
    $gstInspect = Get-Command gst-inspect-1.0 -ErrorAction SilentlyContinue
    if (-not $gstInspect) { $gstInspect = 'C:\gstreamer\1.0\msvc_x86_64\bin\gst-inspect-1.0.exe' }

    if (Test-Path $gstInspect) {
        # THE decisive check. Version numbers do not matter; what matters is that
        # this specific build ships the NDI plugin AND can load libndi. If this
        # fails, NDI output cannot work no matter what else succeeded.
        $ndi = & $gstInspect ndi 2>&1 | Out-String
        if ($ndi -match 'ndisink' -and $ndi -match 'ndisinkcombiner') {
            $ver = ([regex]::Match($ndi, 'Version\s+(\S+)')).Groups[1].Value
            Write-Ok "GStreamer NDI plugin loaded (version $ver) - ndisink + ndisinkcombiner present"
        } else {
            Write-Fail 'GStreamer NDI plugin did NOT load. NDI output will not work.'
            Write-Host '         Check the NDI runtime is installed and Processing.NDI.Lib.x64.dll exists.' -ForegroundColor Red
        }
    } else {
        Write-Warn 'gst-inspect-1.0 not found - open a NEW shell (PATH changed) and re-run to verify'
    }
}

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
Write-Step 'Summary'

if ($script:Failures.Count -gt 0) {
    Write-Host "  $($script:Failures.Count) step(s) failed:" -ForegroundColor Red
    $script:Failures | ForEach-Object { Write-Host "    - $_" -ForegroundColor Red }
} else {
    Write-Host '  All prerequisite steps completed.' -ForegroundColor Green
}

if ($script:RebootRequired) {
    Write-Host "`n  *** REBOOT REQUIRED (WSL2), then re-run this script to finish. ***`n" -ForegroundColor Yellow
} else {
    Write-Host @"

  Next steps:
    1. Open a NEW terminal (PATH has changed).
    2. Start Docker Desktop and wait for it to report Running.
    3. cp .env.example .env  &&  ./scripts/gen-secrets.sh
    4. ./scripts/gen-selfsigned-cert.sh
    5. docker compose up -d
    6. Verify NDI end-to-end - WINDOWS_SETUP.md section 6.

"@ -ForegroundColor Cyan
}
