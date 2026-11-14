# 打包独立 Windows 可执行程序所需的脚本与多语言资源到 payload.zip
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$payload = Join-Path $PSScriptRoot 'payload.zip'
$stagingParent = Join-Path $root 'artifacts\standalone'
$staging = Join-Path $stagingParent ('payload-staging-' + [guid]::NewGuid().ToString('N'))

Add-Type -AssemblyName System.IO.Compression.FileSystem
New-Item -ItemType Directory -Path $staging -Force | Out-Null
try {
    Copy-Item (Join-Path $root 'scripts') -Destination (Join-Path $staging 'scripts') -Recurse
    Copy-Item (Join-Path $root 'resources') -Destination (Join-Path $staging 'resources') -Recurse
    $tempZip = "$payload.tmp-" + [guid]::NewGuid().ToString('N')
    try {
        [IO.Compression.ZipFile]::CreateFromDirectory($staging, $tempZip, [IO.Compression.CompressionLevel]::Optimal, $false)
        if (Test-Path -LiteralPath $payload) { Remove-Item -LiteralPath $payload -Force }
        Move-Item -LiteralPath $tempZip -Destination $payload -Force
    } finally {
        Remove-Item -LiteralPath $tempZip -Force -ErrorAction SilentlyContinue
    }
} finally {
    Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
}
