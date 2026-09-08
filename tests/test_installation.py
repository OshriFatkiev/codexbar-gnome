"""Exercise the real shell scripts against a disposable GNOME command boundary."""

import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

UUID = "codexbar@inled.es"
ROOT = Path(__file__).resolve().parents[1]


@pytest.fixture
def installation(tmp_path):
    checkout = tmp_path / "checkout with spaces"
    checkout.mkdir()
    for name in ("build.sh", "install.sh"):
        shutil.copy2(ROOT / name, checkout / name)
    (checkout / "schemas").mkdir()
    binaries = tmp_path / "bin"
    binaries.mkdir()
    stub = binaries / "stub"
    stub.write_text(
        f"#!{sys.executable}\n"
        + r"""
import json, os, pathlib, shutil, sys, zipfile
root = pathlib.Path(os.environ["INSTALL_TEST_ROOT"])
dest = pathlib.Path(os.environ["XDG_DATA_HOME"]) / "gnome-shell/extensions/codexbar@inled.es"
failure = os.environ.get("INSTALL_TEST_FAILURE", "")
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
with (root / "calls").open("a") as log:
    log.write(json.dumps([name, *args]) + "\n")
if name == "rm":
    # The old installer contains a hardcoded HOME deletion. Never let a
    # regression test touch anything outside its own disposable directory.
    for arg in args:
        if arg.startswith("-"): continue
        path = pathlib.Path(arg).resolve()
        if not path.is_relative_to(root): sys.exit(99)
        if path.is_dir(): shutil.rmtree(path)
        elif path.exists(): path.unlink()
    sys.exit(0)
if name == "glib-compile-schemas":
    sys.exit(11 if failure == "schema" else 0)
operation = args[0]
if operation == "pack":
    if failure == "pack": sys.exit(12)
    out = next((a.split("=", 1)[1] for a in args if a.startswith("--out-dir=")), ".")
    archive = pathlib.Path(out) / "codexbar@inled.es.shell-extension.zip"
    if failure == "corrupt": archive.write_text("broken archive")
    else:
        with zipfile.ZipFile(archive, "w") as z:
            z.writestr("metadata.json", '{"uuid":"codexbar@inled.es"}')
            z.writestr("extension.js", "new version")
elif operation in ("install", "uninstall"):
    if dest.exists(): shutil.rmtree(dest)
    if operation == "uninstall": sys.exit(0)
    dest.mkdir(parents=True)
    if failure == "install":
        (dest / "partial.js").write_text("partial replacement")
        sys.exit(13)
    archive = next(a for a in args[1:] if not a.startswith("-"))
    with zipfile.ZipFile(archive) as z: z.extractall(dest)
elif operation == "enable":
    sys.exit(14 if failure == "enable" else 0)
"""
    )
    stub.chmod(0o755)
    for name in ("gnome-extensions", "glib-compile-schemas", "rm"):
        (binaries / name).symlink_to(stub)
    scratch = tmp_path / "tmp"
    scratch.mkdir()
    env = {
        "PATH": f"{binaries}:{os.environ['PATH']}",
        "INSTALL_TEST_ROOT": str(tmp_path),
        "XDG_DATA_HOME": str(tmp_path / "data"),
        "XDG_STATE_HOME": str(tmp_path / "state"),
        "TMPDIR": str(scratch),
        "XDG_SESSION_TYPE": "wayland",
    }
    dest = tmp_path / "data/gnome-shell/extensions" / UUID
    dest.mkdir(parents=True)
    (dest / "extension.js").write_text("old version")
    (dest / "old-only.js").write_text("old extra file")
    settings = tmp_path / "data/settings-sentinel"
    settings.write_text("existing settings")
    # A failed build must never install a previous archive by mistake.
    with zipfile.ZipFile(checkout / f"{UUID}.shell-extension.zip", "w") as z:
        z.writestr("extension.js", "stale version")
    return tmp_path, checkout, dest, env


def run_install(installation, failure="", outside=False):
    root, checkout, _, env = installation
    return subprocess.run(
        [str(checkout / "install.sh")],
        cwd=root if outside else checkout,
        env={**env, "INSTALL_TEST_FAILURE": failure},
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )


@pytest.mark.parametrize("failure", ["schema", "pack", "corrupt"])
def test_build_failure_never_replaces_existing_installation(installation, failure):
    root, _, dest, _ = installation
    result = run_install(installation, failure)
    assert result.returncode != 0
    assert (dest / "extension.js").read_text() == "old version"
    assert (dest / "old-only.js").exists()
    assert '"install"' not in (root / "calls").read_text()


def test_upgrade_from_another_directory_preserves_backup_and_settings(installation):
    root, _, dest, _ = installation
    result = run_install(installation, outside=True)
    assert result.returncode == 0, result.stderr
    assert (dest / "extension.js").read_text() == "new version"
    assert not (dest / "old-only.js").exists()
    backups = list((root / "state").rglob("old-only.js"))
    assert len(backups) == 1
    assert (backups[0].parent / "extension.js").read_text() == "old version"
    assert (root / "data/settings-sentinel").read_text() == "existing settings"
    assert '"uninstall"' not in (root / "calls").read_text()


def test_partial_install_failure_restores_old_files(installation):
    _, _, dest, _ = installation
    result = run_install(installation, "install")
    assert result.returncode != 0
    assert (dest / "extension.js").read_text() == "old version"
    assert (dest / "old-only.js").exists()
    assert not (dest / "partial.js").exists()


def test_enable_failure_keeps_valid_install_but_returns_failure(installation):
    root, _, dest, _ = installation
    result = run_install(installation, "enable")
    assert result.returncode != 0
    assert (dest / "extension.js").read_text() == "new version"
    assert list((root / "state").rglob("old-only.js"))
    assert "enable" in result.stderr.lower()


def test_fresh_install(installation):
    _, _, dest, _ = installation
    shutil.rmtree(dest)
    result = run_install(installation, outside=True)
    assert result.returncode == 0, result.stderr
    assert (dest / "extension.js").read_text() == "new version"


def test_backup_failure_prevents_replacement(installation):
    root, _, dest, _ = installation
    (root / "state").write_text("not a writable directory")
    result = run_install(installation)
    assert result.returncode != 0
    assert (dest / "extension.js").read_text() == "old version"
    assert '"install"' not in (root / "calls").read_text()


def test_failed_fresh_install_leaves_no_partial_extension(installation):
    root, _, dest, _ = installation
    shutil.rmtree(dest)
    result = run_install(installation, "install")
    assert result.returncode != 0
    assert not dest.exists()
    assert list((root / "state").rglob("partial.js"))
