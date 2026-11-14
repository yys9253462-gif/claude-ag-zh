param([string]$Configuration = 'Release')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
& (Join-Path $PSScriptRoot 'make-icon.ps1')
$out = Join-Path $root 'artifacts\standalone'
New-Item -ItemType Directory -Path $out -Force | Out-Null
& (Join-Path $PSScriptRoot 'build-payload.ps1')
dotnet publish (Join-Path $PSScriptRoot 'ClaudeZhStandalone.csproj') `
    -c $Configuration -r win-x64 --self-contained true `
    -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:EnableCompressionInSingleFile=true `
    -p:DebugType=None -p:DebugSymbols=false `
    -p:PublishDir="$out\" `
    -p:UseAppHost=true
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Get-Item (Join-Path $out 'ClaudeDesktop-ZH-CN.exe') | Select-Object FullName,Length
