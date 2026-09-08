#!/bin/bash
# Build and install a local checkout, preserving an existing installation.
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
UUID="codexbar@inled.es"
ZIP_FILE="$SCRIPT_DIR/${UUID}.shell-extension.zip"
data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
state_home="${XDG_STATE_HOME:-$HOME/.local/state}"
extension_dir="$data_home/gnome-shell/extensions/$UUID"

if [[ "$data_home" != /* || "$state_home" != /* ]]; then
    echo "Installation failed: XDG data and state directories must be absolute paths." >&2
    exit 1
fi

# build.sh returns success only after validating a freshly generated archive.
"$SCRIPT_DIR/build.sh"

backup_root="$state_home/codexbar/install-backups"
mkdir -p -- "$backup_root"
backup_dir="$(mktemp -d "$backup_root/install.XXXXXX")"
if [[ -e "$extension_dir" || -L "$extension_dir" ]]; then
    cp -a -- "$extension_dir" "$backup_dir/extension"
    echo "Previous installation backed up: $backup_dir/extension"
fi

echo "Installing extension..."
if ! gnome-extensions install --force "$ZIP_FILE"; then
    echo "Installation failed. Recovering the previous installation..." >&2
    # Keep a partial replacement for diagnosis instead of mixing its files
    # with the backup or deleting anything that might help recovery.
    if [[ -e "$extension_dir" || -L "$extension_dir" ]]; then
        mv -- "$extension_dir" "$backup_dir/failed-installation"
    fi
    if [[ -e "$backup_dir/extension" || -L "$backup_dir/extension" ]]; then
        cp -a -- "$backup_dir/extension" "$extension_dir"
        echo "Previous installation restored." >&2
    fi
    echo "Recovery files: $backup_dir" >&2
    exit 1
fi

if ! gnome-extensions enable "$UUID"; then
    echo "Extension installed, but GNOME could not enable it in this session." >&2
    echo "Log out and back in, then run: gnome-extensions enable $UUID" >&2
    echo "Recovery files: $backup_dir" >&2
    exit 1
fi

echo "Extension installed and enabled. Existing provider settings are preserved."
case "${XDG_SESSION_TYPE:-}" in
    x11) echo "To load the new code, press Alt+F2, type r, and press Enter." ;;
    *) echo "Log out and back in to load the new code." ;;
esac
