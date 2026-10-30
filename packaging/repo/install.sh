#!/bin/bash
# Install keep-going (the Stop hook and the `keep-going` command that
# registers it) from its signed package repository, and keep it updating with
# the system:
#
#   curl -fsSL https://ferdousbhai.com/keep-going/install.sh | sudo bash
#
# Every step is idempotent, so re-running is safe. It trusts the
# package-signing key (checked against the fingerprint pinned below), adds the
# [keep-going] repository, installs an Omarchy hook that restores it after
# `omarchy refresh pacman` rewrites /etc/pacman.conf, and installs the package.
# The package is arch=any, so one repository serves x86_64 and aarch64.
#
# Hooks are per-user. For the user who ran sudo, hooks an earlier
# `npx github:ferdousbhai/keep-going` registered at its copy in
# ~/.local/share/keep-going are re-pointed to the package (keep-going
# --migrate); no other host is registered without being asked for.
set -euo pipefail

REPO=keep-going
RELEASES=${KEEP_GOING_RELEASES_URL:-https://github.com/ferdousbhai/keep-going/releases/latest/download}
SIGNING_KEY_FINGERPRINT=52130299581DAD685226900CA89CA1A6A1E74251
PACKAGES=(keep-going)

# --- add_signed_repo (shared) ---
# Trust a project's package-signing key (checked against the pinned
# fingerprint), add its signed pacman repository, and keep the repository
# across `omarchy refresh pacman`, which rewrites /etc/pacman.conf from
# Omarchy's defaults and then runs the user's pre-refresh-pacman hooks.
# Works as root (`sudo bash`) or as a desktop user (sudo inside). This text
# is identical in every installer that uses it, and each repository's test
# pins its hash: change it here and in its twins together.
add_signed_repo() {
  local name="$1" release="$2" fingerprint="$3"
  local conf="/etc/pacman.d/$name.conf" include="Include = /etc/pacman.d/$name.conf"
  local sudo='' key user home hook_dir
  (( EUID == 0 )) || sudo=sudo
  key="$(mktemp)"
  if ! curl -fsSL "$release/$name-signing-key.asc" -o "$key"; then
    rm -f "$key"
    echo "Could not download the package-signing key from $release." >&2
    return 1
  fi
  if ! gpg --batch --with-colons --show-keys "$key" 2>/dev/null | grep -q "^fpr:*:$fingerprint:"; then
    rm -f "$key"
    echo "The downloaded key does not match the pinned fingerprint $fingerprint; nothing was changed." >&2
    return 1
  fi
  $sudo pacman-key --add "$key"
  $sudo pacman-key --lsign-key "$fingerprint"
  rm -f "$key"
  printf '[%s]\nSigLevel = Required DatabaseRequired\nServer = %s\n' "$name" "$release" | $sudo tee "$conf" >/dev/null
  grep -qxF "$include" /etc/pacman.conf || printf '\n%s\n' "$include" | $sudo tee -a /etc/pacman.conf >/dev/null
  user="${SUDO_USER:-${USER:-$(id -un)}}"
  home="$(getent passwd "$user" | cut -d: -f6)"
  if [[ -n $home && -d $home/.config/omarchy ]]; then
    hook_dir="$home/.config/omarchy/hooks/pre-refresh-pacman.d"
    install -d -o "$user" -g "$(id -gn "$user")" "$hook_dir"
    printf '%s\n' '#!/bin/bash' \
      "# Restore the [$name] repository after Omarchy rewrote /etc/pacman.conf." \
      "grep -qxF '$include' /etc/pacman.conf || printf '\\n%s\\n' '$include' | sudo tee -a /etc/pacman.conf >/dev/null" \
      > "$hook_dir/$name"
    chown "$user" "$hook_dir/$name"
    chmod 755 "$hook_dir/$name"
  fi
  $sudo pacman -Sy
}
# --- end add_signed_repo ---

if ! command -v pacman >/dev/null; then
  echo "pacman not found: this installer is for Omarchy and other Arch Linux systems." >&2
  exit 1
fi

echo "Adding the [$REPO] repository"
add_signed_repo "$REPO" "$RELEASES" "$SIGNING_KEY_FINGERPRINT"

echo "Installing ${PACKAGES[*]}"
if command -v omarchy-pkg-add >/dev/null; then
  # Omarchy refuses direct `pacman -Syu` (system upgrades go through `omarchy update`), so install
  # the way Omarchy installs its own apps; the next `omarchy update` brings everything current.
  omarchy-pkg-add "${PACKAGES[@]}"
else
  # Upgrade and install in one transaction: add_signed_repo has just synced every database, and
  # installing from those without upgrading is a partial upgrade.
  sudo=''
  (( EUID == 0 )) || sudo=sudo
  $sudo pacman -Syu --needed --noconfirm "${PACKAGES[@]}"
fi

# Re-point the desktop user's npx-copy hooks, as that user and in their home.
user="${SUDO_USER:-${USER:-$(id -un)}}"
uid="$(id -u "$user" 2>/dev/null || echo 0)"
home="$(getent passwd "$user" | cut -d: -f6)"
if (( uid != 0 )) && [[ -n $home ]]; then
  if (( EUID == 0 )); then
    runuser -u "$user" -- env HOME="$home" keep-going --migrate \
      || echo "Could not re-point $user's hooks; run as $user: keep-going --migrate" >&2
  else
    keep-going --migrate || echo "Could not re-point your hooks; run: keep-going --migrate" >&2
  fi
fi

cat <<EOT

Done. Register keep-going with each agent you use (as yourself, not root):
  keep-going --claude --ghost     # or --muse, --grok, --cursor, --copilot, --agy, --opencode, --all
Hooks run /usr/lib/keep-going, so updates arrive with the rest of the system:
omarchy update (or pacman -Syu elsewhere). Check registrations: keep-going --status
EOT
