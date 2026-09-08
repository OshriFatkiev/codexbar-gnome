# CodexBar for GNOME

A GNOME Shell extension to monitor AI provider usage metrics directly from the system panel. This extension acts as a graphical interface for the CodexBar CLI, providing real-time visibility into your API quotas and usage tiers.

![CodexBar Panel](<demo.gif>)

## Features

- Real-time monitoring of AI provider usage (Gemini, OpenAI, etc).
- Support for standard Codex and Codex Spark 5-hour/weekly usage tiers
- Toggle between Remaining Quota and Used Quota display modes.
- Automatic background refreshes with configurable intervals.
- Visual warnings (color changes) when reaching quota limits.
- Automatic resolution of CodexBar CLI paths (Homebrew supported).
- Calculate and display weekly usage pace from the existing quota window
- Render Code review usage when the Linux API supplies it
- Add regression coverage for the new normalization and pace calculation
- Added support to show AI economic expenditure

## Updates  
- Support Codex Spark usage tiers from the direct ChatGPT endpoint (`additional_rate_limits`)
- Render provider-supplied detail sections (OpenRouter credits, API key budget, spend history) with a new `show-provider-details` toggle
- Derive a meaningful usage percent for balance-based providers (e.g. OpenRouter) from the Credits / API key sections
- Welcome screen now installs the cookie importer and SSL helper scripts directly from the repo (raw GitHub) instead of PyPI

## Requirements

The extension requires the CodexBar CLI tool installed on your system.

### Install CodexBar CLI

It is recommended to install the CLI via Homebrew, which is the official way:

```bash
brew install steipete/tap/codexbar
```
Homebrew exists for Linux (and is a good package manager). For those who don't know, it can be installed with
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

### Install Cookie Importer (only for Codex users)
It is now distributed separately from the extension and no longer requires PyPI. Download it directly from the repo into `~/.local/bin` (the extension looks there by default):
```bash
mkdir -p ~/.local/bin && curl -fsSL https://raw.githubusercontent.com/InledGroup/codexbar-gnome/main/scripts/codexbar-cookie-importer -o ~/.local/bin/codexbar-cookie-importer && chmod +x ~/.local/bin/codexbar-cookie-importer
```
It is a dependency-free bash script (uses `secret-tool`, `openssl`, `sqlite3`).

### Install helper to Trust the Certificate of the Antigravity Language Server (only for Antigravity users)
This minimal script is invoked by the extension when you click on the trust antigravity cert button and what it does is save the certificate in the system trust store, elevating privileges.   
Since it elevates privileges, it would be unreasonable to integrate the elevation logic into the extension (as JustPerfection told me) so it is served as a standalone script that the user must decide to install, thus complying with GJS guidelines. It is now a dependency-free bash script (no PyPI):

```bash
mkdir -p ~/.local/bin && curl -fsSL https://raw.githubusercontent.com/InledGroup/codexbar-gnome/main/scripts/codexbar-ssl-helper -o ~/.local/bin/codexbar-ssl-helper && chmod +x ~/.local/bin/codexbar-ssl-helper && codexbar-ssl-helper
```


## Installation

### From EGO
Reviewed by the great GNOME experts, with the confidence of correct operation and stability.
[https://extensions.gnome.org/extension/9841/codexbar/](https://extensions.gnome.org/extension/9841/codexbar/)

### From Github  
1. Clone or fork the repo
2. Ensure `gnome-extensions`, `glib-compile-schemas`, and `unzip` are installed.
3. Run `./install.sh` from the checkout, or invoke it by its full path from another directory.
4. - On Wayland:
      - Log out and log in
      - **For fast development and iteration**: Run `dbus-run-session gnome-shell --wayland --devkit`. You need to have installed Mutter Devkit
   - On X11: `Alt+F2` and type `r` and press enter.

The installer builds and checks a fresh ZIP before replacing the extension.
Existing provider settings are preserved. Before an upgrade, it saves the
installed files under `${XDG_STATE_HOME:-~/.local/state}/codexbar/install-backups/`
and prints the exact backup path. If replacement fails, it restores those files
and keeps any partial replacement beside the backup for diagnosis.

An enable failure returns a nonzero exit status but leaves the successfully
installed files in place. Follow the printed instructions to log out and back
in, then enable the extension. A successful upgrade still needs the session
reload described above to run the new code. To build a ZIP without installing,
run `./build.sh`.

### From Unofficial Gnome Shell Store
I am working on a very interesting concept to present, which is the automated review of extensions with AI. 
The package is not updated very regularly, the site is still a concept, but it can be tested [https://extensions-gnome.github.io/?ext=codexbar%40inled.es](https://extensions-gnome.github.io/?ext=codexbar%40inled.es)

## Configuration

Access the settings through the gear icon in the extension menu or using your extension manager client.

### Provider Commands

Each provider must be configured with a command that returns JSON output.

For Gemini usage through Antigravity (`agy`), enable **Antigravity** and choose
**Auto**. Run `agy` once and complete sign-in first:

```bash
codexbar --provider antigravity --source auto --format json
```

CodexBar can launch its own `agy` process or reuse a running one to read quota.
If the panel shows a dash, open `agy`, let it finish signing in, and refresh.
A CLI response with `source: "offline"` and `usageKnown: false` contains local
history, not known quota; it cannot supply a usage percentage. Explicit OAuth
uses separate credentials and does not use the signed-in local `agy` service.
See [CodexBar's Antigravity documentation](https://github.com/steipete/CodexBar/blob/main/docs/antigravity.md).

**Gemini CLI** remains available for supported accounts, including
Code Assist Standard and Enterprise. Google ended Gemini CLI's Google login for
individual, AI Pro and Ultra accounts on June 18, 2026; those accounts should use
Antigravity instead. See [Google's deprecation notice](https://developers.google.com/gemini-code-assist/docs/deprecations/code-assist-individuals).

For a supported Gemini Code Assist account, use **Auto** or **Provider API**:

```bash
codexbar --provider gemini --source api --format json
```

Although this API path reads Gemini CLI OAuth credentials, CodexBar does not
accept `--source oauth` for Gemini. The preferences only offer supported sources
for Gemini and Antigravity; a previously saved unsupported source is marked until
you explicitly select a supported replacement. Custom commands are preserved.

The extension will automatically attempt to locate the `codexbar` binary in common locations such as `/home/linuxbrew/.linuxbrew/bin/` if an absolute path is not provided. 

Certain vendors have specific fields in Codexbar CLI, whose interpretation may not have been implemented so this is a great opportunity for you to implement support (if you want) and do a PR.

### API Keys (e.g. OpenRouter)

Some providers (OpenRouter with `--source api`) authenticate the CodexBar CLI via an environment variable, e.g. `OPENROUTER_API_KEY`, instead of a token cached on disk. Setting that variable in `~/.zshrc`, `~/.bashrc`, or similar is **not enough**: GNOME Shell is started by your login/display manager, not by an interactive shell, so it never sources your shell's dotfiles, and any command the extension runs (as a child process of GNOME Shell) inherits GNOME Shell's environment, not your terminal's.

To make the variable visible to the extension, add it to your systemd user environment instead:

```bash
mkdir -p ~/.config/environment.d
echo 'OPENROUTER_API_KEY=sk-or-v1-...' > ~/.config/environment.d/codexbar.conf
chmod 600 ~/.config/environment.d/codexbar.conf
```

Then log out and log back in. `environment.d` files are only read once, when your `systemd --user` manager starts — if it's still running from before you added the file (e.g. lingering is enabled: `loginctl show-user $USER | grep Linger`), a normal logout/login won't pick it up. In that case, apply it to the running instance once, then log out/in as usual:

```bash
systemctl --user import-environment OPENROUTER_API_KEY
```

You can confirm GNOME Shell actually has the variable with:

```bash
tr '\0' '\n' < /proc/$(pgrep -x gnome-shell)/environ | grep OPENROUTER_API_KEY
```

Without it, `codexbar --provider openrouter --source api` still returns valid JSON, but with a top-level `error` field and no `usage.details` — so the OpenRouter tab shows only a bare, empty tier instead of the Credits / API key / Spend history breakdown.

### Display Mode

You can choose how metrics are displayed:
- **Remaining**: Shows the percentage of quota left (default).
- **Used**: Shows the percentage of quota consumed.


## Join the Community

Follow us on social media for updates, discussions, and support:

- **Discord**: [Join our Discord server](https://discord.com/invite/PSeTkDMnr)
- **Matrix**: [Join the Matrix server](https://matrix.inled.es)
- **Mastodon**: [@inled on mastodon.social](https://mastodon.social/@inled)
- **YouTube**: [Inled Group YouTube Channel](https://www.youtube.com/@inledgroup)
- **X (Twitter)**: [@inledgroup on X](https://x.com/inledgroup)

## License

This project is licensed under the terms of the MIT license. Contributions are welcome! 

> [!WARNING]
> If you base your code on ours or remix it using AI, you must credit the original repository out of respect for the contributors and the creator.

## About:  
I've been working on a lot of projects lately and wasn't sure if people really cared about them until this one completely brought back my excitement for development and showed me how useful it can be for users. The GNOME community is fantastic.

> [!NOTE]
> **AI DISCLAIMER**
> AI has been used on this project. ALL THE CODE that AI made has been reviewed and edited by humans (you can see the difference between ai comments and human-made comments XD)
