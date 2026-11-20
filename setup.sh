#!/bin/sh
set -eu

fail() { printf '%s\n' "$*" >&2; exit 1; }
[ "$(uname -s)" = Darwin ] || fail 'Kokoro-ru requires macOS 13 or newer.'
arch=$(uname -m)
case $arch in arm64|x86_64) ;; *) fail "Unsupported macOS architecture: $arch" ;; esac
if [ "$(sysctl -in sysctl.proc_translated 2>/dev/null || :)" = 1 ]; then
    fail 'Run setup natively, not under Rosetta.'
fi
version=$(sw_vers -productVersion)
[ "${version%%.*}" -ge 13 ] || fail 'Kokoro-ru requires macOS 13 or newer.'
[ -n "${HOME:-}" ] || fail 'HOME is not set.'
command -v uv >/dev/null 2>&1 || fail 'uv is required and must be on PATH: https://docs.astral.sh/uv/getting-started/installation/'

package=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
root="$HOME/Library/Application Support/omp-kokoro-ru"
venv="$root/.venv"
python="$venv/bin/python"

rm -f "$root/ready-v1"
if [ ! -x "$python" ]; then
    uv venv --managed-python --python 3.12 "$venv"
fi
"$python" -X utf8 -c 'import platform, sys; sys.exit(sys.version_info[:2] != (3, 12) or platform.machine() != sys.argv[1])' "$arch" ||
    fail "Recreate '$venv' with native $arch Python 3.12 and rerun setup."
uv pip install --python "$python" -r "$package/requirements.txt"
exec "$python" -X utf8 "$package/kokoro_ru.py" setup "$root"
