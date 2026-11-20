$ErrorActionPreference = 'Stop'

if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is not set.' }
if (-not (Get-Command uv -CommandType Application -ErrorAction SilentlyContinue)) {
    throw 'uv is required and must be on PATH: https://docs.astral.sh/uv/getting-started/installation/'
}
if (-not [Environment]::Is64BitOperatingSystem -or
    $env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -or $env:PROCESSOR_ARCHITEW6432) {
    throw 'Kokoro-ru requires native Windows x64.'
}

$root = Join-Path $env:LOCALAPPDATA 'omp-kokoro-ru'
$venv = Join-Path $root '.venv'
$python = Join-Path $venv 'Scripts\python.exe'
$ready = Join-Path $root 'ready-v1'
$requirements = Join-Path $PSScriptRoot 'requirements.txt'
$script = Join-Path $PSScriptRoot 'kokoro_ru.py'

if (Test-Path -LiteralPath $ready) { Remove-Item -LiteralPath $ready }
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
    & uv venv --python 3.12 $venv
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
& $python -X utf8 -c 'import platform, sys; sys.exit(sys.version_info[:2] != (3, 12) or platform.machine() != sys.argv[1])' AMD64
if ($LASTEXITCODE -ne 0) { throw "Recreate '$venv' with native x64 Python 3.12 and rerun setup." }
& uv pip install --python $python -r $requirements
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& $python -X utf8 $script setup $root
exit $LASTEXITCODE
