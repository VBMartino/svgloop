# Starts llama.cpp's server with a vision-capable model for SVGLoop (Windows PowerShell).
# Example:
#   .\scripts\start-llama.ps1 -Model C:\models\model.gguf -Mmproj C:\models\mmproj.gguf
# -FitTarget leaves that many MiB of VRAM free (needs a llama.cpp build with --fit-target); 0 turns it off.
param(
  [Parameter(Mandatory = $true)][string]$Model,
  [Parameter(Mandatory = $true)][string]$Mmproj,
  [string]$Server = "llama-server",
  [string]$Alias = "",
  [int]$Port = 8080,
  [int]$Context = 16384,
  [int]$FitTarget = 0,
  [int]$SleepIdleSeconds = 0
)
$ErrorActionPreference = "Stop"
foreach ($f in $Model, $Mmproj) { if (-not (Test-Path $f)) { throw "Not found: $f" } }
if (-not $Alias) { $Alias = [IO.Path]::GetFileNameWithoutExtension($Model) }
$llamaArgs = @("-m", $Model, "--mmproj", $Mmproj, "--alias", $Alias, "--host", "127.0.0.1", "--port", $Port,
  "-c", $Context, "--parallel", "1", "--jinja")
if ($FitTarget -gt 0) { $llamaArgs += @("--fit-target", $FitTarget) }
if ($SleepIdleSeconds -gt 0) { $llamaArgs += @("--sleep-idle-seconds", $SleepIdleSeconds) }
Write-Host "Serving $Alias at http://127.0.0.1:$Port/v1"
Write-Host "Set SVGLOOP_BASE_URL=http://127.0.0.1:$Port/v1 and SVGLOOP_MODEL=$Alias"
& $Server @llamaArgs
