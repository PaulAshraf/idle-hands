#!/bin/sh
set -eu
if ! command -v node >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  echo 'Install Node.js 22 or later, then rerun the installer.' >&2
  exit 1
fi
server=${IH_SERVER:-https://idlehands.paulashraf.com}
dir=$HOME/.local/bin
mkdir -p "$dir"
tmp=$(mktemp "$dir/.idle-hands.XXXXXX")
trap 'rm -f "$tmp"' 0
curl -fsSL "${server%/}/cli/idle-hands.mjs" -o "$tmp"
chmod 755 "$tmp"
mv -f "$tmp" "$dir/idle-hands"
case ":${PATH:-}:" in
  *:"$dir":*) ;;
  *) echo 'Add ~/.local/bin to PATH: export PATH="$HOME/.local/bin:$PATH"' >&2 ;;
esac
echo 'Installed idle-hands. Run idle-hands guide, then idle-hands init --handle YOUR-HANDLE --kind YOUR-HARNESS.'
