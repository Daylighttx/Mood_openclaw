param(
    [string]$Output = "openclaw-deploy.tar.gz"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

Write-Host "=== OpenClaw AI Town - Deployment Packager ===" -ForegroundColor Cyan

if (-not (Test-Path "$ProjectRoot\dist")) {
    Write-Host "[ERROR] dist/ not found. Run 'pnpm build' first." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path "$ProjectRoot\openclaw.mjs")) {
    Write-Host "[ERROR] openclaw.mjs not found." -ForegroundColor Red
    exit 1
}

$TempDir = Join-Path $env:TEMP "openclaw-pack-$(Get-Random)"
New-Item -ItemType Directory -Path $TempDir -Force | Out-Null

Write-Host "[1/7] Copying dist/..." -ForegroundColor Yellow
Copy-Item -Recurse "$ProjectRoot\dist" "$TempDir\dist" -Force

Write-Host "[2/7] Copying project root files..." -ForegroundColor Yellow
Copy-Item "$ProjectRoot\openclaw.mjs" "$TempDir\openclaw.mjs"
Copy-Item "$ProjectRoot\package.json" "$TempDir\package.json"
Copy-Item "$ProjectRoot\pnpm-workspace.yaml" "$TempDir\pnpm-workspace.yaml" -ErrorAction SilentlyContinue
Copy-Item "$ProjectRoot\.npmrc" "$TempDir\.npmrc" -ErrorAction SilentlyContinue
Copy-Item "$ProjectRoot\CHANGELOG.md" "$TempDir\CHANGELOG.md" -ErrorAction SilentlyContinue
Copy-Item "$ProjectRoot\LICENSE" "$TempDir\LICENSE" -ErrorAction SilentlyContinue
Copy-Item "$ProjectRoot\README.md" "$TempDir\README.md" -ErrorAction SilentlyContinue

if (Test-Path "$ProjectRoot\pnpm-lock.yaml") {
    Copy-Item "$ProjectRoot\pnpm-lock.yaml" "$TempDir\pnpm-lock.yaml"
}

Write-Host "[3/7] Copying patches/..." -ForegroundColor Yellow
if (Test-Path "$ProjectRoot\patches") {
    Copy-Item -Recurse "$ProjectRoot\patches" "$TempDir\patches" -Force
}

Write-Host "[4/7] Copying runtime scripts/ (required by package.json lifecycle)..." -ForegroundColor Yellow
$ScriptsDir = "$TempDir\scripts"
New-Item -ItemType Directory -Path $ScriptsDir -Force | Out-Null
$RuntimeScripts = @(
    "preinstall-package-manager-warning.mjs",
    "postinstall-bundled-plugins.mjs",
    "npm-runner.mjs",
    "windows-cmd-helpers.mjs",
    "crabbox-wrapper.mjs"
)
foreach ($script in $RuntimeScripts) {
    $src = Join-Path $ProjectRoot "scripts\$script"
    if (Test-Path $src) {
        Copy-Item $src "$ScriptsDir\$script"
    }
}
$LibDir = "$ScriptsDir\lib"
New-Item -ItemType Directory -Path $LibDir -Force | Out-Null
$LibScripts = @(
    "official-external-channel-catalog.json",
    "official-external-plugin-catalog.json",
    "official-external-provider-catalog.json",
    "package-dist-imports.mjs"
)
foreach ($script in $LibScripts) {
    $src = Join-Path $ProjectRoot "scripts\lib\$script"
    if (Test-Path $src) {
        Copy-Item $src "$LibDir\$script"
    }
}

Write-Host "[5/7] Copying docs/, skills/, extensions/, qa/..." -ForegroundColor Yellow
if (Test-Path "$ProjectRoot\docs") {
    Copy-Item -Recurse "$ProjectRoot\docs" "$TempDir\docs" -Force
    if (Test-Path "$TempDir\docs\.generated") {
        Remove-Item -Recurse -Force "$TempDir\docs\.generated"
    }
}
if (Test-Path "$ProjectRoot\skills") {
    Copy-Item -Recurse "$ProjectRoot\skills" "$TempDir\skills" -Force
}
if (Test-Path "$ProjectRoot\extensions") {
    Copy-Item -Recurse "$ProjectRoot\extensions" "$TempDir\extensions" -Force
}
if (Test-Path "$ProjectRoot\qa") {
    Copy-Item -Recurse "$ProjectRoot\qa" "$TempDir\qa" -Force
}

Copy-Item "$ProjectRoot\scripts\deploy-ecs.sh" "$TempDir\deploy-ecs.sh" -ErrorAction SilentlyContinue

Write-Host "[6/7] Excluding unnecessary files from dist/..." -ForegroundColor Yellow
Get-ChildItem -Path "$TempDir\dist" -Recurse -Include "*.map","*.d.ts","*.d.mts","*.d.cts" | Remove-Item -Force
if (Test-Path "$TempDir\dist\control-ui") {
    Remove-Item -Recurse -Force "$TempDir\dist\control-ui"
}

Write-Host "[7/7] Creating archive: $Output" -ForegroundColor Yellow
$OutputPath = if ([System.IO.Path]::IsPathRooted($Output)) { $Output } else { Join-Path $ProjectRoot $Output }

Push-Location $TempDir
tar -czf $OutputPath .
Pop-Location

Remove-Item -Recurse -Force $TempDir

$SizeMB = [math]::Round((Get-Item $OutputPath).Length / 1MB, 1)
Write-Host ""
Write-Host "=== Pack Complete ===" -ForegroundColor Green
Write-Host "  Archive: $OutputPath"
Write-Host "  Size:    ${SizeMB} MB"
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Upload to ECS:  scp $OutputPath root@YOUR_SERVER:/tmp/"
Write-Host "  2. Deploy on ECS:  bash /tmp/deploy-ecs.sh /tmp/$(Split-Path -Leaf $OutputPath)"
Write-Host ""
