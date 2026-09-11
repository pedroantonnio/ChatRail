# Safe PowerShell 5.1 client helpers for the local ChatRail.
# Dot-source this file: . .\chatrail-client.ps1

$script:ChatRailBaseUri = 'http://127.0.0.1:3333'

function Invoke-ChatRailJson {
  param(
    [Parameter(Mandatory=$true)][string]$Method,
    [Parameter(Mandatory=$true)][string]$Path,
    [object]$Body = $null
  )

  $uri = $script:ChatRailBaseUri.TrimEnd('/') + '/' + $Path.TrimStart('/')
  if ($null -eq $Body) {
    return Invoke-RestMethod -Method $Method -Uri $uri
  }

  $json = $Body | ConvertTo-Json -Depth 20 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  return Invoke-RestMethod -Method $Method -Uri $uri -ContentType 'application/json; charset=utf-8' -Body $bytes
}

function Get-ChatRailStatus {
  Invoke-ChatRailJson -Method Get -Path '/status'
}

function Register-ChatRailRecipient {
  param(
    [Parameter(Mandatory=$true)][string]$Phone,
    [Parameter(Mandatory=$true)][string]$Name,
        [string]$Source = '',
    [string[]]$Tags = @()
  )
  Invoke-ChatRailJson -Method Post -Path '/recipients' -Body @{
    phone = $Phone
    name = $Name
    source = $Source
    tags = $Tags
  }
}

function Send-ChatRailMessage {
  param(
    [Parameter(Mandatory=$true)][string]$Phone,
    [Parameter(Mandatory=$true)][string]$Text,
    [string]$IdempotencyKey = '',
    [switch]$DryRun,
    [switch]$Force
  )
  if ([string]::IsNullOrWhiteSpace($IdempotencyKey)) {
    $IdempotencyKey = 'chatrail-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  }
  Invoke-ChatRailJson -Method Post -Path '/send' -Body @{
    phone = $Phone
    text = $Text
    idempotencyKey = $IdempotencyKey
    dryRun = [bool]$DryRun
    force = [bool]$Force
  }
}

function Get-ChatRailReplies {
  param([switch]$All)
  $path = if ($All) { '/replies?unreadOnly=0' } else { '/replies?unreadOnly=1' }
  Invoke-ChatRailJson -Method Get -Path $path
}

function Get-ChatRailUnresolved {
  Invoke-ChatRailJson -Method Get -Path '/unresolved?limit=100'
}
