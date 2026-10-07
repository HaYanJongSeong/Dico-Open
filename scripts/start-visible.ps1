$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$entrypoint = Join-Path $root 'dist\src\cli.js'
if (!(Test-Path -LiteralPath $entrypoint)) {
    throw 'Build missing. Run: npx pnpm@10.33.1 build'
}
$node = (Get-Command node.exe -ErrorAction Stop).Source
$Host.UI.RawUI.WindowTitle = 'Dico-Open'
while ($true) {
    & $node $entrypoint
    if ($LASTEXITCODE -in @(0, 130, -1073741510)) { break }
    Write-Host 'Bot exited with error. Restarting in 2 seconds...'
    Start-Sleep -Seconds 2
}
