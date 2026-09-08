#!/bin/bash
# Script to package the extension
set -euo pipefail

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "$SCRIPT_DIR"

UUID="codexbar@inled.es"
ZIP_FILE="${UUID}.shell-extension.zip"

for tool in glib-compile-schemas gnome-extensions unzip; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "Build failed: required command '$tool' is missing." >&2
        exit 1
    fi
done

# Never confuse a previous archive with the output of this build.
build_dir="$(mktemp -d "${TMPDIR:-/tmp}/codexbar-build.XXXXXX")"
trap 'rm -rf -- "$build_dir"' EXIT

echo "Compiling schemas..."
glib-compile-schemas --strict schemas/

echo "Packaging Codexbar"
gnome-extensions pack \
    --extra-source=extension.js \
    --extra-source=prefs.js \
    --extra-source=usageApi.js \
    --extra-source=providerSources.js \
    --extra-source=secret.js \
    --extra-source=stylesheet.css \
    --extra-source=core/ \
    --extra-source=adapters/ \
    --extra-source=media/ \
    --schema=schemas/org.gnome.shell.extensions.codexbar.gschema.xml \
    --out-dir="$build_dir"

echo "Checking extension archive..."
unzip -tq "$build_dir/$ZIP_FILE"
mv -- "$build_dir/$ZIP_FILE" "$SCRIPT_DIR/$ZIP_FILE"
echo "Extension packed: $SCRIPT_DIR/$ZIP_FILE"
