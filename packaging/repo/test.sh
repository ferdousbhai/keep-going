#!/bin/bash
# Checks for the signed-repository installer. add_signed_repo is shared
# verbatim with the other products' installers (Ghost, iCloud for Omarchy, Cloud Calendar), and each
# repository pins its hash: change them all together.
set -euo pipefail
cd "$(dirname "$0")"

bash -n install.sh

hash_of() { sed -n '/^# --- add_signed_repo (shared) ---$/,/^# --- end add_signed_repo ---$/p' "$1" | sed '1d;$d' | sha256sum | cut -d' ' -f1; }
[[ "$(hash_of install.sh)" == "$(cat add_signed_repo.sha256)" ]] \
  || { echo "add_signed_repo in install.sh differs from the pinned shared copy" >&2; exit 1; }

grep -q '^SIGNING_KEY_FINGERPRINT=[0-9A-F]\{40\}$' install.sh \
  || { echo "install.sh has no signing key fingerprint pinned" >&2; exit 1; }

echo "ok - installer syntax, shared add_signed_repo hash and pinned key"
