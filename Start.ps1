param([switch]$Demo)
$ErrorActionPreference='Stop'
function Write-CompanionRuntimeHost {
 param([string]$Root,[hashtable]$Record)
 $directory=Join-Path $Root 'data'
 [System.IO.Directory]::CreateDirectory($directory) | Out-Null
 $target=Join-Path $directory 'runtime_host.json'
 $temporary=$target+'.'+[guid]::NewGuid().ToString('N')+'.tmp'
 $previous=$target+'.'+[guid]::NewGuid().ToString('N')+'.previous'
 $encoding=New-Object System.Text.UTF8Encoding($false)
 [System.IO.File]::WriteAllText($temporary,($Record|ConvertTo-Json -Depth 10),$encoding)
 try { if([System.IO.File]::Exists($target)){[System.IO.File]::Replace($temporary,$target,$previous)}else{[System.IO.File]::Move($temporary,$target)} }
 finally {if([System.IO.File]::Exists($temporary)){[System.IO.File]::Delete($temporary)};if([System.IO.File]::Exists($previous)){[System.IO.File]::Delete($previous)}}
}
Set-Location -LiteralPath $PSScriptRoot
$env:TEMP=Join-Path $PSScriptRoot 'temp'
$env:TMP=$env:TEMP
[System.IO.Directory]::CreateDirectory($env:TEMP) | Out-Null
if($Demo){ & node (Join-Path $PSScriptRoot 'src/cli.mjs') demo }else{ & node (Join-Path $PSScriptRoot 'src/cli.mjs') start }
exit $LASTEXITCODE
