$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host '=== ChatRail setup ==='
$nodeVersion = node -p "process.versions.node"
$major = [int]($nodeVersion.Split('.')[0])
if ($major -lt 20) {
  throw "Node.js 20+ is required. Found $nodeVersion"
}
Write-Host "Node $nodeVersion OK"

if (-not (Test-Path '.env')) {
  Copy-Item '.env.example' '.env'
  Write-Host 'Created .env from .env.example'
}

Write-Host 'Installing pinned dependencies...'
npm install

Write-Host 'Running syntax + regression + integration selftests...'
npm run verify
Write-Host 'Running concurrency/persistence stress test...'
npm run stress

Write-Host 'Checking provider package contracts...'
npm run provider:smoke

Write-Host 'Running doctor...'
npm run doctor

Write-Host ''
Write-Host 'SETUP COMPLETE'
Write-Host 'Start with: .\start.ps1'
