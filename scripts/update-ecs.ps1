param(
    [string]$User = "openclaw",

    [string]$InstallDir = "/opt/openclaw"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

Write-Host "=== OpenClaw - 构建打包 ===" -ForegroundColor Cyan

# ── Step 1: Build ─────────────────────────────────────────
Write-Host "[1/2] Building..." -ForegroundColor Yellow
Push-Location $ProjectRoot
try {
    pnpm build
    if ($LASTEXITCODE -ne 0) { throw "Build failed" }
} finally {
    Pop-Location
}
Write-Host "  Build OK" -ForegroundColor Green

if (-not (Test-Path "$ProjectRoot\dist")) {
    Write-Host "[ERROR] dist/ not found after build" -ForegroundColor Red
    exit 1
}

# ── Step 2: Package dist + runtime essentials ──────────────
Write-Host "[2/2] Packaging..." -ForegroundColor Yellow
$ArchiveName = "openclaw-update-$(Get-Date -Format 'yyyyMMdd-HHmmss').tar.gz"
$ArchivePath = Join-Path $ProjectRoot $ArchiveName

Push-Location $ProjectRoot
try {
    tar -czf "$ArchivePath" `
        -C "$ProjectRoot" `
        dist `
        docs/reference/templates `
        openclaw.mjs `
        package.json `
        pnpm-lock.yaml `
        pnpm-workspace.yaml `
        scripts
    if ($LASTEXITCODE -ne 0) { throw "tar packaging failed" }
} finally {
    Pop-Location
}

$SizeMB = [math]::Round((Get-Item $ArchivePath).Length / 1MB, 2)
Write-Host "  Archive: $ArchiveName (${SizeMB}MB)" -ForegroundColor Green

Write-Host ""
Write-Host "=== 打包完成 ===" -ForegroundColor Green
Write-Host "  Archive: $ArchivePath"
Write-Host ""
Write-Host "手动部署步骤:" -ForegroundColor Cyan
Write-Host "  1. scp $ArchiveName ${User}@<服务器IP>:/tmp/"
Write-Host "  2. ssh ${User}@<服务器IP>"
Write-Host "  3. sudo tar -xzf /tmp/$ArchiveName -C $InstallDir && rm /tmp/$ArchiveName"
Write-Host "  4. cd $InstallDir && npm install --omit=dev --ignore-scripts"
Write-Host "  5. sudo systemctl restart openclaw-gateway"
