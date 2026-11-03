# Installs the isolated OpenCode CLI from the GitHub Releases of BrunoMoraes-Z/mycode.
# Usage: irm https://raw.githubusercontent.com/BrunoMoraes-Z/mycode/isolated/install-isolated.ps1 | iex
$ErrorActionPreference = "Stop"

$repo = "BrunoMoraes-Z/mycode"
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
$asset = "opencode-win32-$arch.exe"
$dir = Join-Path $env:LOCALAPPDATA "Programs\opencode"
$exe = Join-Path $dir "opencode.exe"

$release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers @{ "User-Agent" = "opencode-isolated-installer" }
$download = $release.assets | Where-Object { $_.name -eq $asset } | Select-Object -First 1
if (-not $download) { throw "Release $($release.tag_name) has no $asset asset." }

New-Item -ItemType Directory -Force $dir | Out-Null
Write-Host "Downloading $asset from $($release.tag_name)..."
Invoke-WebRequest $download.browser_download_url -OutFile "$exe.new" -UseBasicParsing
# A running opencode.exe cannot be overwritten, but it can be renamed.
if (Test-Path $exe) {
  Remove-Item "$exe.old" -Force -ErrorAction SilentlyContinue
  Move-Item $exe "$exe.old" -Force
}
Move-Item "$exe.new" $exe -Force

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not (($userPath -split ";") -contains $dir)) {
  [Environment]::SetEnvironmentVariable("Path", (($userPath.TrimEnd(";"), $dir) -join ";").TrimStart(";"), "User")
  Write-Host "Added $dir to your user PATH. Open a new terminal to use it."
}
$env:Path = "$env:Path;$dir"

Write-Host "Installed $(& $exe --version) at $exe"
