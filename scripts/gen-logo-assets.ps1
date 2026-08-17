# =============================================================================
# Live Bridge - brand asset generator
# =============================================================================
# Derives every dashboard logo asset from the single master image in brand/.
# Design-time only: this is never run by a container or at request time. It uses
# System.Drawing from the .NET Framework that ships with Windows, so it installs
# nothing (project rule 14).
#
#   powershell -ExecutionPolicy Bypass -File scripts\gen-logo-assets.ps1
#
# Outputs into dashboard/public/ (served at the site root):
#   livebridge-logo-dark.png  header lockup, navy remapped for a dark surface
#   livebridge-logo.png       full logo incl. RTMP|SRT|SERVER, original colours
#   livebridge-mark.png       square LB monogram (apple-touch-icon)
#   favicon.png               64x64 monogram
#
# Re-run after replacing brand/livebridge-logo-master.jpg. The crop boxes below
# are measured from that specific master; a different master needs them redone
# (see "Deriving the crop boxes" at the bottom).
# =============================================================================

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$src  = Join-Path $root 'brand\livebridge-logo-master.jpg'
$out  = Join-Path $root 'dashboard\public'

if (-not (Test-Path $src)) { throw "Master logo not found: $src" }
New-Item -ItemType Directory -Force $out | Out-Null

# --- Crop boxes, measured from the master (1920x1080) -------------------------
$LOCK_X = 160          # left edge of all ink
$LOCK_Y = 317          # top edge of the main lockup
$LOCK_R = 1724         # right edge of all ink
$LOCK_B = 658          # bottom of the main lockup (the blank band is 659..688)
$FULL_B = 742          # bottom of the RTMP | SRT | SERVER strip
$MARK_R = 749          # right edge of the LB monogram (divider sits at ~818..825)

# --- Load the master into a raw 24bpp buffer ---------------------------------
$bmp = New-Object System.Drawing.Bitmap($src)
$w = $bmp.Width; $h = $bmp.Height
$rect = New-Object System.Drawing.Rectangle(0,0,$w,$h)
$d = $bmp.LockBits($rect,
                   [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
                   [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$stride = $d.Stride
$src24  = New-Object byte[] ($stride * $h)
[System.Runtime.InteropServices.Marshal]::Copy($d.Scan0, $src24, 0, $src24.Length)
$bmp.UnlockBits($d); $bmp.Dispose()

Write-Host "master: ${w}x${h}"

# -----------------------------------------------------------------------------
# Crop a region and key the white background out to alpha.
#
# The master is a JPEG on solid white, so a hard threshold would leave a light
# halo on every antialiased edge. Instead this uses the standard unpremultiply
# key:
#     alpha  = 255 - min(R,G,B)
#     colour = (C - min) * 255 / alpha
# White gives alpha 0; a half-covered edge pixel recovers the full-strength ink
# colour at ~50% alpha, so edges stay clean at any scale.
#
# $lighten remaps the near-black navy ink to slate-300 for use on a dark
# surface. It discriminates on MAX CHANNEL, not luminance: the navy tops out
# around 58, while the darkest stops of the red (~196) and blue (~190) brand
# gradients sit far above it. A luminance test drags those gradient stops under
# the same threshold as the navy and washes the play triangle out to grey.
# -----------------------------------------------------------------------------
function New-KeyedCrop {
    param($x0, $y0, $cw, $ch, [bool]$lighten, $padX, $padY)

    $ow = $cw + 2*$padX; $oh = $ch + 2*$padY
    $bm = New-Object System.Drawing.Bitmap($ow, $oh,
              [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $r  = New-Object System.Drawing.Rectangle(0,0,$ow,$oh)
    $bd = $bm.LockBits($r,
              [System.Drawing.Imaging.ImageLockMode]::WriteOnly,
              [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $ds  = $bd.Stride
    $buf = New-Object byte[] ($ds * $oh)

    for ($y = 0; $y -lt $ch; $y++) {
        $sBase = ($y0 + $y) * $stride
        $dBase = ($y + $padY) * $ds
        for ($x = 0; $x -lt $cw; $x++) {
            $si = $sBase + ($x0 + $x) * 3
            $b = [int]$src24[$si]; $g = [int]$src24[$si+1]; $rr = [int]$src24[$si+2]
            $mn = [Math]::Min($rr, [Math]::Min($g, $b))
            $a  = 255 - $mn
            if ($a -le 2) { continue }            # white -> leave transparent

            $cr = [int](($rr-$mn)*255/$a)
            $cg = [int](($g -$mn)*255/$a)
            $cb = [int](($b -$mn)*255/$a)
            if ($cr -gt 255) { $cr = 255 }
            if ($cg -gt 255) { $cg = 255 }
            if ($cb -gt 255) { $cb = 255 }

            if ($lighten) {
                $mx = [Math]::Max($cr, [Math]::Max($cg, $cb))
                if ($mx -lt 100) { $cr = 203; $cg = 213; $cb = 225 }   # slate-300
            }

            $di = $dBase + ($x + $padX) * 4
            $buf[$di]   = [byte]$cb
            $buf[$di+1] = [byte]$cg
            $buf[$di+2] = [byte]$cr
            $buf[$di+3] = [byte]$a
        }
    }

    [System.Runtime.InteropServices.Marshal]::Copy($buf, 0, $bd.Scan0, $buf.Length)
    $bm.UnlockBits($bd)
    return $bm
}

function Save-Png {
    param($bm, $targetW, $path)
    $tw = [int]$targetW
    $th = [int][Math]::Round($bm.Height * ($targetW / $bm.Width))
    $o  = New-Object System.Drawing.Bitmap($tw, $th,
              [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $gr = [System.Drawing.Graphics]::FromImage($o)
    $gr.InterpolationMode   = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $gr.PixelOffsetMode     = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $gr.CompositingQuality  = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $gr.Clear([System.Drawing.Color]::Transparent)
    $gr.DrawImage($bm, (New-Object System.Drawing.Rectangle(0,0,$tw,$th)))
    $gr.Dispose()
    $o.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
    $o.Dispose()
    $kb = [int]((Get-Item $path).Length / 1024)
    Write-Host ("  {0,-26} {1}x{2}  {3} KB" -f [System.IO.Path]::GetFileName($path), $tw, $th, $kb)
}

$lockW = $LOCK_R - $LOCK_X + 1
$lockH = $LOCK_B - $LOCK_Y + 1
$fullH = $FULL_B - $LOCK_Y + 1
$markW = $MARK_R - $LOCK_X + 1
$markH = $lockH

Write-Host 'generated:'

# Header lockup, dark-surface variant.
$b = New-KeyedCrop $LOCK_X $LOCK_Y $lockW $lockH $true 12 12
Save-Png $b 660 (Join-Path $out 'livebridge-logo-dark.png'); $b.Dispose()

# Full logo, original colours - light backgrounds and documentation only.
$b = New-KeyedCrop $LOCK_X $LOCK_Y $lockW $fullH $false 16 16
Save-Png $b 900 (Join-Path $out 'livebridge-logo.png'); $b.Dispose()

# Square LB monogram, padded to 1:1 so icons are not letterboxed.
$padX = [int][Math]::Max(0, [Math]::Round(($markH - $markW) / 2)) + 10
$padY = [int][Math]::Max(0, [Math]::Round(($markW - $markH) / 2)) + 10
$b = New-KeyedCrop $LOCK_X $LOCK_Y $markW $markH $false $padX $padY
Save-Png $b 256 (Join-Path $out 'livebridge-mark.png')
Save-Png $b  64 (Join-Path $out 'favicon.png')
$b.Dispose()

Write-Host "done -> $out"

# =============================================================================
# Deriving the crop boxes for a new master
# =============================================================================
# Count "ink" pixels (any channel < 235) per row and per column. The outermost
# non-zero row/column give the overall bounding box; the blank bands inside it
# give the seams:
#   - a blank ROW band separates the main lockup from the tagline strip
#   - a blank COLUMN band on either side of the thin vertical rule separates
#     the LB monogram from the LIVE BRIDGE wordmark
# For the current master those came out as: bbox rows 317..742, cols 160..1724;
# blank rows 659..688; blank cols 790..817 and 826..851 (rule at 818..825).
# =============================================================================
