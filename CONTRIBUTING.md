# Contributing to this maintained fork

Contribute to [OshriFatkiev/codexbar-gnome](https://github.com/OshriFatkiev/codexbar-gnome). This fork builds on [InledGroup/codexbar-gnome](https://github.com/InledGroup/codexbar-gnome) and retains its MIT license and credit.

## Branch workflow

- `main` is the tested, recommended version to install. Start focused feature or fix branches from `main` and target pull requests there.
- `integration` combines candidates for local testing and user verification. It may contain changes that are not ready for `main`.
- After checks and visual acceptance, the maintainer promotes the verified result to `main`. Keep `integration` aligned with accepted changes before starting the next combined test.
- Bring useful upstream changes into a review branch first, test their interaction with this fork, and promote them through the same process. Do not replace this fork's maintained branches with upstream wholesale.

Keep each change focused. Match the recent commit style, such as `fix(panel): keep an exhausted window visible`. Preserve existing settings, custom provider commands, and installed-user compatibility. No agent-attribution trailers belong in commits.

## Local validation

On a GNOME development machine with GJS, the installer build tools listed in the README, and `uv`, run:

```bash
gjs -m test_all_providers.js &&
gjs -m test_panel.js &&
gjs -m test_panel_reset.js &&
gjs -m test_popup_bars.js &&
gjs -m test_refresh.js &&
gjs -m test_provider_sources.js &&
gjs -m test_cli_fetcher.js &&
uv run --with pytest pytest -q tests/test_installation.py &&
bash build.sh &&
git diff --check
```

The GJS tests exercise normalization, provider selection, refresh ownership, CLI calls, panel behavior, and popup bar theme updates. The installer tests use temporary directories and stub GNOME commands. `build.sh` validates schemas and the packaged archive. Report which checks you ran and any limitations; a declared Shell version is not proof of testing on it.

Add meaningful regression coverage when behavior changes. Provider parsing cases belong in `test_all_providers.js`; use the existing focused tests for panel, refresh, source, and CLI behavior. Avoid tests that merely check incidental wording or styling constants.

For visual changes, install with `./install.sh`, reload the Shell, and verify normal usage, exhausted reset labels, and unavailable data as relevant. The installer backs up the previous files and preserves settings. If you use Developer & Testing Options, save and restore the `dev-custom-output-*` settings after testing; never publish a temporary comparison build as the regular extension.

## Reporting problems

Use [this fork's issues](https://github.com/OshriFatkiev/codexbar-gnome/issues). Include the extension commit, GNOME Shell version, provider/connection mode, and reproduction steps. Redact credentials and account information; do not paste API keys, cookies, or complete environment dumps.

The upstream repository and store listing are separate projects. Report a fork-specific problem here first, and link an upstream report when the underlying issue has been confirmed there.
