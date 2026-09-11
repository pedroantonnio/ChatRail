$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
npm run verify
npm run stress
npm run provider:smoke
npm run doctor
Write-Host 'ALL LOCAL TESTS PASSED'
