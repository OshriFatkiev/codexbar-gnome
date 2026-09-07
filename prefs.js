import Gio from "gi://Gio";
import GioUnix from "gi://GioUnix";
import GLib from "gi://GLib";
import GObject from "gi://GObject";
import Gdk from "gi://Gdk";
import Gtk from "gi://Gtk";
import Adw from "gi://Adw";
import {
  ExtensionPreferences,
  gettext as _,
} from "resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js";
import {
  storeToken,
  loadToken,
  clearToken,
  nullTokenSchema,
} from "./secret.js";
import {
  adoptCustomProviders,
  buildCliCommand,
  DIRECT_API,
  parseGeneratedCommand,
  providerSourceSelection,
} from "./providerSources.js";

/**
 * Human label for a source. Looked up lazily so gettext runs after the
 * translation domain is bound, not at module load.
 * @param {string} source
 * @returns {string}
 */
const sourceLabel = (source) =>
  ({
    [DIRECT_API]: _("Direct API (session cookies)"),
    auto: _("Auto"),
    web: _("Web dashboard"),
    cli: _("Local CLI"),
    oauth: _("OAuth"),
    // Qualified because it would otherwise read as a second "Direct API" on
    // the two rows that offer both.
    api: _("Provider API (via CLI)"),
  })[source] || source;

/**
 * Predefined providers list.
 * Lista de proveedores predefinidos.
 *
 * `supportsDirectApi` marks the providers this extension can query itself with
 * a keyring cookie; the rest reach their source through codexbar-cli.
 */
const PREDEFINED_PROVIDERS = [
  {
    id: "codex",
    name: "Codex",
    useApi: true,
    supportsDirectApi: true,
    defaultCommand: "",
  },
  {
    id: "ollama",
    name: "Ollama Cloud",
    useApi: true,
    supportsDirectApi: true,
    defaultCommand: "",
  },
  {
    id: "claude",
    name: "Claude",
    useApi: false,
    defaultCommand: "codexbar --provider claude --source cli --format json",
  },
    {
    id: "antigravity",
    name: "Antigravity",
    useApi: false,
    defaultCommand:
      "codexbar --provider antigravity --source auto --format json",
  },
  {
    id: "gemini",
    name: "Gemini CLI (Code Assist)",
    useApi: false,
    defaultCommand: "codexbar --provider gemini --source api --format json",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    useApi: false,
    defaultCommand: "codexbar --provider deepseek --source api --format json",
  },
  {
    id: "copilot",
    name: "Copilot",
    useApi: false,
    defaultCommand: "codexbar --provider copilot --source api --format json",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    useApi: false,
    defaultCommand: "codexbar --provider openrouter --source api --format json",
  },
  {
    id: "perplexity",
    name: "Perplexity",
    useApi: false,
    defaultCommand: "codexbar --provider perplexity --source api --format json",
  },
  {
    id: "mistral",
    name: "Mistral",
    useApi: false,
    defaultCommand: "codexbar --provider mistral --source api --format json",
  },
];

/**
 * Preferences page for CodexBar.
 * Página de preferencias para CodexBar.
 */
const CodexBarPrefsPage = GObject.registerClass(
  class CodexBarPrefsPage extends Adw.PreferencesPage {
    _init(settings, extensionPath = null) {
      super._init({
        title: _("General"),
        icon_name: "dialog-information-symbolic",
      });

      this._settings = settings;
      this._extensionPath = extensionPath;
      this._providerRows = [];

      this.add(this._buildSettingsGroup());
      this.add(this._buildProvidersGroup());
      this.add(this._buildDeveloperGroup());
      this.add(this._buildContributeGroup());
      this.add(this._buildMaintenanceGroup());

      this.connect("destroy", () => {
        this._settings = null;
        this._providerRows = [];
      });
    }

    /**
     * From here I can pass a simulated codexbar-cli output and thus test providers that I don't have.
     */
    _buildDeveloperGroup() {
      const group = new Adw.PreferencesGroup({
        title: _("Developer & Testing Options"),
        description: _(
          "Simulate custom CLI outputs and view debug logs.",
        ),
      });

      // 1. Toggle Custom Output
      const enabledRow = new Adw.SwitchRow({
        title: _("Test with Custom CLI Output"),
        subtitle: _(
          "Simulate Codexbar-CLI outputs to test providers or other things and see how the extension renders the data",
        ),
        active: this._settings.get_boolean("dev-custom-output-enabled"),
      });
      this._settings.bind(
        "dev-custom-output-enabled",
        enabledRow,
        "active",
        Gio.SettingsBindFlags.DEFAULT,
      );
      group.add(enabledRow);

      // 2. Mock Provider Name
      const providerNameRow = new Adw.EntryRow({
        title: _("Simulated Provider Name"),
        text: this._settings.get_string("dev-custom-output-provider-name") || "Mock Provider",
      });
      this._settings.bind(
        "dev-custom-output-provider-name",
        providerNameRow,
        "text",
        Gio.SettingsBindFlags.DEFAULT,
      );
      group.add(providerNameRow);

      // 3. Mock JSON Input
      const jsonRow = new Adw.ActionRow({
        title: _("Codexbar-CLI custom output"),
        subtitle: _("Paste the raw JSON output to test"),
      });
      
      const scrolled = new Gtk.ScrolledWindow({
        min_content_height: 120,
        hexpand: true,
        vexpand: false,
      });
      scrolled.set_has_frame(true);
      
      const jsonView = new Gtk.TextView({
        monospace: true,
        wrap_mode: Gtk.WrapMode.WORD,
      });
      jsonView.get_buffer().set_text(
        this._settings.get_string("dev-custom-output-json") || "[]",
        -1,
      );
      jsonView.get_buffer().connect("changed", () => {
        const buffer = jsonView.get_buffer();
        const start = buffer.get_start_iter();
        const end = buffer.get_end_iter();
        const text = buffer.get_text(start, end, true).trim();
        this._settings.set_string("dev-custom-output-json", text);
      });

      scrolled.set_child(jsonView);
      
      const jsonBox = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 6,
        margin_top: 8,
        margin_bottom: 8,
        margin_start: 8,
        margin_end: 8,
      });
      jsonBox.append(scrolled);
      
      jsonRow.add_suffix(jsonBox);
      group.add(jsonRow);


      return group;
    }

    /**
     * Build the contribute and contact group.
     * Construye el grupo de contribución y contacto.
     */
    _buildContributeGroup() {
      const group = new Adw.PreferencesGroup({
        title: _("Contribute & Contact"),
        description: _(
          "Enjoy the community of Codexbar contributors and other Inled projects. We are waiting for you!",
        ),
      });

      // Pull Request / Contribute
      const prRow = new Adw.ActionRow({
        title: _("Add a New Provider"),
        subtitle: _(
          "Help the community by submitting a Pull Request on GitHub",
        ),
      });
      prRow.add_prefix(new Gtk.Image({ icon_name: "window-new-symbolic" }));

      const prBtn = new Gtk.Button({
        icon_name: "go-next-symbolic",
        valign: Gtk.Align.CENTER,
        css_classes: ["flat"],
      });
      prBtn.connect("clicked", () => {
        Gio.AppInfo.launch_default_for_uri(
          "https://github.com/InledGroup/codexbar-gnome",
          null,
        );
      });
      prRow.add_suffix(prBtn);
      group.add(prRow);

      // Review on GNOME Extensions
      const reviewRow = new Adw.ActionRow({
        title: _("Leave a Review"),
        subtitle: _(
          "Rate the extension on EGO or share on social media.",
        ),
      });
      reviewRow.add_prefix(new Gtk.Image({ icon_name: "starred-symbolic" }));

      const reviewBtn = new Gtk.Button({
        icon_name: "go-next-symbolic",
        valign: Gtk.Align.CENTER,
        css_classes: ["flat"],
      });
      reviewBtn.connect("clicked", () => {
        Gio.AppInfo.launch_default_for_uri(
          "https://extensions.gnome.org/extension/9841/codexbar/",
          null,
        );
      });
      reviewRow.add_suffix(reviewBtn);
      group.add(reviewRow);

      // Contact Inled
      const contactRow = new Adw.ActionRow({
        title: _("Contact Inled"),
        subtitle: _("Questions? Suggestions? Write to us at hi@inled.es"),
      });
      contactRow.add_prefix(
        new Gtk.Image({ icon_name: "mail-message-new-symbolic" }),
      );

      const contactBtn = new Gtk.Button({
        icon_name: "go-next-symbolic",
        valign: Gtk.Align.CENTER,
        css_classes: ["flat"],
      });
      contactBtn.connect("clicked", () => {
        Gio.AppInfo.launch_default_for_uri("mailto:hi@inled.es", null);
      });
      contactRow.add_suffix(contactBtn);
      group.add(contactRow);

      // Visit Website
      const webRow = new Adw.ActionRow({
        title: _("Visit inled.es"),
        subtitle: _(
          "Discover more tools and projects that might interest you!",
        ),
      });
      webRow.add_prefix(new Gtk.Image({ icon_name: "web-browser-symbolic" }));

      const webBtn = new Gtk.Button({
        icon_name: "go-next-symbolic",
        valign: Gtk.Align.CENTER,
        css_classes: ["suggested-action"],
      });
      webBtn.connect("clicked", () => {
        Gio.AppInfo.launch_default_for_uri("https://inled.es", null);
      });
      webRow.add_suffix(webBtn);
      group.add(webRow);

      // Social Media
      const socialRow = new Adw.ActionRow({
        title: _("Join the Community"),
        subtitle: _("¡We have new Discord and Matrix channels!"),
      });
      socialRow.add_prefix(
        new Gtk.Image({ icon_name: "system-users-symbolic" }),
      );

      const socialBox = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 12,
        valign: Gtk.Align.CENTER,
      });

      const createSocialBtn = (name, url, tooltip) => {
        const iconPath = GLib.build_filenamev([
          this._extensionPath,
          "media",
          "logos",
          `${name}-symbolic.svg`,
        ]);
        const btn = new Gtk.Button({
          css_classes: ["flat"],
          tooltip_text: tooltip,
        });
        if (GLib.file_test(iconPath, GLib.FileTest.EXISTS)) {
          const gicon = Gio.Icon.new_for_string(iconPath);
          btn.set_child(new Gtk.Image({ gicon: gicon }));
        } else {
          btn.set_label(tooltip);
        }
        btn.connect("clicked", () => {
          Gio.AppInfo.launch_default_for_uri(url, null);
        });
        return btn;
      };

      socialBox.append(
        createSocialBtn(
          "discord",
          "https://discord.com/invite/PSeTkDMnr",
          "Discord",
        ),
      );
      socialBox.append(
        createSocialBtn(
          "matrix",
          "https://matrix.to/#/!POXBFohLnmrKwRBxTi:matrix.org?via=matrix.org",
          "Matrix",
        ),
      );
      socialBox.append(
        createSocialBtn(
          "mastodon",
          "https://mastodon.social/@inled",
          "Mastodon",
        ),
      );
      socialBox.append(
        createSocialBtn(
          "youtube",
          "https://www.youtube.com/@inledgroup",
          "YouTube",
        ),
      );
      socialBox.append(
        createSocialBtn("x", "https://x.com/inledgroup", "X (Twitter)"),
      );

      socialRow.add_suffix(socialBox);
      group.add(socialRow);

      return group;
    }

    /**
     * Build the general settings group (Refresh interval, Display mode).
     * Construye el grupo de ajustes generales (Intervalo de refresco, Modo de visualización).
     */
    _buildSettingsGroup() {
      const group = new Adw.PreferencesGroup({
        title: _("Settings"),
      });

      const refreshRow = new Adw.SpinRow({
        title: _("Refresh Interval (minutes)"),
        adjustment: new Gtk.Adjustment({
          lower: 1,
          upper: 1440,
          step_increment: 1,
          value: this._settings.get_int("refresh-interval"),
        }),
      });
      this._settings.bind(
        "refresh-interval",
        refreshRow.adjustment,
        "value",
        Gio.SettingsBindFlags.DEFAULT,
      );
      group.add(refreshRow);

      const displayModeRow = new Adw.ComboRow({
        title: _("Display Mode"),
        model: new Gtk.StringList({
          strings: [_("Used"), _("Remaining")],
        }),
        selected: this._settings.get_string("display-mode") === "used" ? 0 : 1,
      });
      displayModeRow.connect("notify::selected", () => {
        this._settings.set_string(
          "display-mode",
          displayModeRow.selected === 0 ? "used" : "remaining",
        );
      });
      group.add(displayModeRow);

      const panelProvidersRow = new Adw.ComboRow({
        title: _("Providers in Panel"),
        subtitle: _(
          "All providers shows each one collapsed to its most constrained window",
        ),
        model: new Gtk.StringList({
          strings: [_("Selected provider"), _("All providers")],
        }),
        selected:
          this._settings.get_string("panel-providers") === "all" ? 1 : 0,
      });
      panelProvidersRow.connect("notify::selected", () => {
        this._settings.set_string(
          "panel-providers",
          panelProvidersRow.selected === 1 ? "all" : "active",
        );
      });
      group.add(panelProvidersRow);

      const panelLogoRow = new Adw.SwitchRow({
        title: _("Show Provider Logo in Panel"),
        subtitle: _("Display the active provider's logo next to the indicator"),
        active: this._settings.get_boolean("panel-show-logo"),
      });
      this._settings.bind(
        "panel-show-logo",
        panelLogoRow,
        "active",
        Gio.SettingsBindFlags.DEFAULT,
      );
      group.add(panelLogoRow);

      const showLogosRow = new Adw.SwitchRow({
        title: _("Show Provider Logos"),
        subtitle: _(
          "Display the logo of each AI provider in the selection tabs",
        ),
        active: this._settings.get_boolean("show-logos"),
      });
      this._settings.bind(
        "show-logos",
        showLogosRow,
        "active",
        Gio.SettingsBindFlags.DEFAULT,
      );
      group.add(showLogosRow);

      const showPacingInfoRow = new Adw.SwitchRow({
        title: _("Show Usage Pacing"),
        subtitle: _(
          "Display weekly pacing estimates (reserve or over pace) for large windows",
        ),
        active: this._settings.get_boolean("show-pacing-info"),
      });
      this._settings.bind(
        "show-pacing-info",
        showPacingInfoRow,
        "active",
        Gio.SettingsBindFlags.DEFAULT,
      );
      group.add(showPacingInfoRow);

      const showProviderDetailsRow = new Adw.SwitchRow({
        title: _("Show Provider Details"),
        subtitle: _(
          "Display the extra detail sections reported by the provider CLI (credits, spend history, rate limits)",
        ),
        active: this._settings.get_boolean("show-provider-details"),
      });
      this._settings.bind(
        "show-provider-details",
        showProviderDetailsRow,
        "active",
        Gio.SettingsBindFlags.DEFAULT,
      );
      group.add(showProviderDetailsRow);

      return group;
    }

    /**
     * Build the AI providers configuration group.
     * Construye el grupo de configuración de proveedores de IA.
     */
    _buildProvidersGroup() {
      const group = new Adw.PreferencesGroup({
        title: _("AI Providers"),
        description: _(
          "Enable providers and pick how each one connects. Direct API uses session cookies from your keyring; the other choices run codexbar-cli with that --source. Antigravity also needs the plugin.",
        ),
      });

      const activeProvidersJson = this._settings.get_string("providers");
      let activeProviders = [];
      try {
        activeProviders = JSON.parse(activeProvidersJson);
      } catch (e) {
        activeProviders = [];
      }

      const adopted = adoptCustomProviders(
        activeProviders,
        PREDEFINED_PROVIDERS,
      );
      // Persist straight away rather than waiting for the user to touch a
      // control: until this lands in settings the panel keeps reading the old
      // custom-* ids, and those are what cost the row its logo.
      const adoptedJson = JSON.stringify(adopted);
      if (adoptedJson !== JSON.stringify(activeProviders)) {
        this._settings.set_string("providers", adoptedJson);
      }
      activeProviders = adopted;

      const saveProviders = async () => {
        const newProviders = [];
        for (const row of this._providerRows) {
          if (row._enabledSwitch.active) {
            newProviders.push({
              id: row._id,
              name: row._name,
              command: row._commandEntry.get_text(),
              useApi: row._useApi,
              ...(row._source ? { source: row._source } : {}),
            });

            if (row._useApi) {
              const token = row._tokenEntry.get_text();
              if (token) {
                await storeToken(row._id, token);
              }
            }
          }
        }
        this._settings.set_string("providers", JSON.stringify(newProviders));
      };

      // Re-added rather than reordered in place: Adw.PreferencesGroup has no
      // reorder API, so the rows are detached and appended in the new order,
      // with the "add" row kept last.
      let addBtnRow = null;
      const applyRowOrder = () => {
        this._providerRows.forEach((row) => group.remove(row));
        if (addBtnRow) group.remove(addBtnRow);
        this._providerRows.forEach((row) => group.add(row));
        if (addBtnRow) group.add(addBtnRow);
        refreshHandles();
      };

      // Only enabled rows carry an order, since saveProviders writes just
      // those; a disabled row has no place in the sequence and cannot be
      // dragged or dropped onto.
      const isOrderable = (row) => !!row && row._enabledSwitch.active;

      // The row currently being dragged. Held here rather than passed through
      // the drag content, which only needs to carry something GTK can type.
      let draggedRow = null;

      const refreshHandles = () => {
        const orderable = this._providerRows.filter(isOrderable);
        this._providerRows.forEach((row) => {
          if (row._dragHandle) {
            row._dragHandle.visible = isOrderable(row) && orderable.length > 1;
          }
        });
      };

      const dropRowOnto = (target) => {
        const source = draggedRow;
        draggedRow = null;
        if (!source || source === target) return false;
        if (!isOrderable(source) || !isOrderable(target)) return false;

        const from = this._providerRows.indexOf(source);
        const to = this._providerRows.indexOf(target);
        if (from === -1 || to === -1) return false;

        this._providerRows.splice(from, 1);
        this._providerRows.splice(to, 0, source);
        applyRowOrder();
        saveProviders();
        return true;
      };

      const createProviderRow = (info, activeData = null) => {
        const isEnabled = activeData !== null;
        const isPredefined = PREDEFINED_PROVIDERS.some((p) => p.id === info.id);

        // Handle command defaults and migrations
        // Manejar valores por defecto y migraciones de comandos
        let command = info.defaultCommand || "";
        if (activeData) {
          if (
            activeData.command &&
            (activeData.command.includes("--provider") ||
              info.useApi ||
              !isPredefined)
          ) {
            command = activeData.command;
          } else {
            command = info.defaultCommand;
          }
        }

        const row = new Adw.ExpanderRow({
          title: info.name,
          subtitle: isEnabled ? _("Enabled") : _("Disabled"),
          expanded: isEnabled,
        });

        row._id = activeData ? activeData.id : info.id;
        row._name = info.name;

        // Which sources this row offers, and which one it starts on. Only
        // predefined rows get a selector - a custom provider's command is
        // whatever the user typed, so claiming a source for it would be a
        // guess. Saved configs predate `source`, so fall back to reading it
        // off the stored command (or the Direct API flag) before the default.
        const storedSource =
          activeData?.source ||
          (activeData?.useApi ? DIRECT_API : null) ||
          parseGeneratedCommand(activeData?.command)?.source ||
          (info.useApi ? DIRECT_API : null) ||
          parseGeneratedCommand(info.defaultCommand)?.source ||
          "cli";
        const selection = providerSourceSelection(info, storedSource);
        const sourceOptions = selection.options;

        if (isPredefined) {
          row._source = selection.source;
        } else {
          row._source = null;
        }
        row._useApi = row._source === DIRECT_API;

        const enabledSwitch = new Gtk.Switch({
          active: isEnabled,
          valign: Gtk.Align.CENTER,
        });
        enabledSwitch.connect("notify::active", () => {
          row.set_subtitle(enabledSwitch.active ? _("Enabled") : _("Disabled"));
          row.expanded = enabledSwitch.active;
          refreshHandles();
          saveProviders();
        });
        row.add_suffix(enabledSwitch);
        row._enabledSwitch = enabledSwitch;

        // Drag to reorder. PreferencesGroup has no reorder API, so the drop
        // rearranges this._providerRows and applyRowOrder re-adds every row.
        const dragHandle = new Gtk.Image({
          icon_name: "list-drag-handle-symbolic",
          valign: Gtk.Align.CENTER,
          css_classes: ["dim-label"],
          tooltip_text: _("Drag to reorder the tabs and the panel"),
        });

        const dragSource = new Gtk.DragSource({
          actions: Gdk.DragAction.MOVE,
        });
        dragSource.connect("prepare", () => {
          if (!isOrderable(row)) return null;
          draggedRow = row;
          return Gdk.ContentProvider.new_for_value(row._id);
        });
        dragSource.connect("drag-begin", (source) => {
          // Collapsed first: these rows expand to a command entry and buttons,
          // and dragging that whole box around is unreadable.
          row.expanded = false;
          source.set_icon(Gtk.WidgetPaintable.new(row), 0, 0);
        });
        dragSource.connect("drag-end", () => {
          draggedRow = null;
        });
        dragHandle.add_controller(dragSource);

        const dropTarget = new Gtk.DropTarget({
          actions: Gdk.DragAction.MOVE,
          formats: Gdk.ContentFormats.new_for_gtype(GObject.TYPE_STRING),
        });
        dropTarget.connect("drop", () => dropRowOnto(row));
        row.add_controller(dropTarget);

        row.add_prefix(dragHandle);
        row._dragHandle = dragHandle;

        const box = new Gtk.Box({
          orientation: Gtk.Orientation.VERTICAL,
          spacing: 6,
          margin_top: 12,
          margin_bottom: 12,
          margin_start: 12,
          margin_end: 12,
        });

        // Show the section the chosen source needs, and keep the command in
        // sync with it. A command the user has hand-edited is left alone -
        // only one we generated (or an empty one) gets rewritten.
        const applySource = (source, { rewriteCommand = true } = {}) => {
          row._source = source;
          row._useApi = source === DIRECT_API;
          apiBox.visible = row._useApi;
          cliBox.visible = !row._useApi;

          if (rewriteCommand && !row._useApi) {
            const current = row._commandEntry.get_text();
            if (!current.trim() || parseGeneratedCommand(current)) {
              row._commandEntry.set_text(buildCliCommand(info.id, source));
            }
          }
        };

        if (isPredefined) {
          const sourceRow = new Gtk.Box({ spacing: 6 });
          sourceRow.append(
            new Gtk.Label({
              label: _("Connection:"),
              xalign: 0,
              valign: Gtk.Align.CENTER,
            }),
          );

          const sourceDropdown = new Gtk.DropDown({
            model: Gtk.StringList.new(sourceOptions.map((source) =>
              source === selection.unsupportedSource
                ? `${sourceLabel(source)} (${_("unsupported for this provider")})`
                : sourceLabel(source),
            )),
            selected: sourceOptions.indexOf(row._source),
            valign: Gtk.Align.CENTER,
            hexpand: true,
          });
          sourceDropdown.connect("notify::selected", () => {
            const picked = sourceOptions[sourceDropdown.get_selected()];
            if (!picked || picked === row._source) return;
            applySource(picked);
            saveProviders();
          });

          sourceRow.append(sourceDropdown);
          box.append(sourceRow);

          if (info.id === "gemini" || info.id === "antigravity") {
            box.append(new Gtk.Label({
              label: info.id === "gemini"
                ? _("For supported Gemini Code Assist accounts, including Standard and Enterprise. Personal, Google AI Pro and Ultra accounts should use Antigravity with Auto instead. Auto and Provider API read Gemini CLI's Google login; the separate OAuth source is not supported.")
                : _("For Gemini usage in Antigravity, choose Auto. Run agy once and complete sign-in. CodexBar can then launch agy to read your limits. OAuth uses a separate login and may provide fewer quota details. If limits are unavailable, open agy and refresh."),
              xalign: 0,
              wrap: true,
              css_classes: ["dim-label"],
            }));
          }
        }

        const apiBox = new Gtk.Box({
          orientation: Gtk.Orientation.VERTICAL,
          spacing: 6,
        });
        // Built only where Direct API is reachable, so the other rows don't
        // each fire a pointless keyring lookup for a token they can't use.
        if (info.supportsDirectApi) {
          // For Direct API providers like Codex
          // Para proveedores de API directa como Codex
          const tokenEntry = new Gtk.PasswordEntry({
            placeholder_text: _(
              "Authentication Cookie (starts with __Secure...)",
            ),
          });
          loadToken(row._id).then((token) => {
            if (token) tokenEntry.set_text(token);
          }).catch(() => {});

          tokenEntry.connect("changed", async () => {
            await storeToken(row._id, tokenEntry.get_text().trim());
            saveProviders();
          });
          row._tokenEntry = tokenEntry;

          const importBtn = new Gtk.Button({
            label: _("Auto-Login from Browser"),
            margin_top: 6,
            tooltip_text: _(
              "Uses a local Python script to extract cookies from Chrome/Brave for this provider.",
            ),
          });

          const spinner = new Gtk.Spinner({
            valign: Gtk.Align.CENTER,
            margin_start: 6,
          });
          const btnBox = new Gtk.Box({ spacing: 6, margin_top: 6 });
          btnBox.append(importBtn);
          btnBox.append(spinner);

          importBtn.connect("clicked", () => {
            importBtn.sensitive = false;
            spinner.start();
            this._importFromBrowser(row._id, tokenEntry, () => {
              importBtn.sensitive = true;
              spinner.stop();
            });
          });

          apiBox.append(
            new Gtk.Label({
              label: _("Session Cookies:"),
              xalign: 0,
              css_classes: ["caption"],
            }),
          );
          apiBox.append(tokenEntry);
          apiBox.append(btnBox);
          apiBox.append(
            new Gtk.Label({
              label: _("Manual entry: Paste your session cookies here."),
              xalign: 0,
              css_classes: ["dim-label"],
            }),
          );
        }

        const cliBox = new Gtk.Box({
          orientation: Gtk.Orientation.VERTICAL,
          spacing: 6,
        });
        {
          const commandEntry = new Gtk.Entry({
            placeholder_text: _("CLI Command (e.g. codexbar --provider ...)"),
            text: command,
          });
          commandEntry.connect("changed", saveProviders);
          row._commandEntry = commandEntry;

          const labelBox = new Gtk.Box({ spacing: 6 });
          labelBox.append(
            new Gtk.Label({ label: _("CLI Command:"), xalign: 0 }),
          );

          if (isPredefined) {
            const resetBtn = new Gtk.Button({
              label: _("Reset Default"),
              valign: Gtk.Align.CENTER,
              css_classes: ["flat"],
            });
            resetBtn.connect("clicked", () => {
              commandEntry.set_text(
                row._source && row._source !== DIRECT_API
                  ? buildCliCommand(info.id, row._source)
                  : info.defaultCommand,
              );
              saveProviders();
            });
            labelBox.append(resetBtn);
          }

          cliBox.append(labelBox);
          cliBox.append(commandEntry);

          if (info.id === "antigravity") {
            const hasLsof = !!GLib.find_program_in_path("lsof");

            if (!hasLsof) {
              let lsofCmd = "sudo apt install lsof";
              if (GLib.find_program_in_path("pacman")) {
                lsofCmd = "sudo pacman -S lsof";
              } else if (GLib.find_program_in_path("dnf")) {
                lsofCmd = "sudo dnf install lsof";
              }
              const lsofLabel = new Gtk.Label({
                label: _(
                  `⚠️ Antigravity requires the 'lsof' utility to detect the local server ports. Run this command to install it:\n\n${lsofCmd}`,
                ),
                xalign: 0,
                use_markup: false,
                wrap: true,
                css_classes: ["dim-label"],
              });
              lsofLabel.set_margin_top(6);
              cliBox.append(lsofLabel);
            }

            // Antigravity SSL certificate setup instruction
            const certLabel = new Gtk.Label({
              label: _(
                "💡 Antigravity requires a trusted local SSL certificate to work. So we have made a python script to help you do this in a single command:\n\npip install codexbar-ssl-helper && codexbar-ssl-helper",
              ),
              xalign: 0,
              use_markup: false,
              wrap: true,
              css_classes: ["dim-label"],
            });
            certLabel.set_margin_top(12);
            cliBox.append(certLabel);
          }
        }

        box.append(apiBox);
        box.append(cliBox);
        // Visibility only: rewriting here would fire the entry's "changed"
        // handler and save a half-built row list.
        applySource(row._source, { rewriteCommand: false });

        if (!isPredefined) {
          const deleteBtn = new Gtk.Button({
            label: _("Remove Provider"),
            margin_top: 12,
            css_classes: ["destructive-action"],
          });
          deleteBtn.connect("clicked", () => {
            group.remove(row);
            this._providerRows = this._providerRows.filter((r) => r !== row);
            refreshHandles();
            saveProviders();
          });
          box.append(deleteBtn);
        }

        row.add_row(box);
        this._providerRows.push(row);
        return row;
      };

      // Configured providers render in the order they are stored in, which is
      // also the order of the popup tabs and of the panel in all-providers
      // mode. Rendering by PREDEFINED_PROVIDERS instead discarded that order on
      // every open, even though saveProviders had written it out faithfully.
      // Predefined providers that aren't configured follow, so they can still
      // be switched on.
      const claimedIds = new Set();
      const claimedNames = new Set();

      const rows = activeProviders.map((provider) => {
        const nameLower = (provider.name || "").toLowerCase();
        const predefined =
          PREDEFINED_PROVIDERS.find((info) => info.id === provider.id) ||
          PREDEFINED_PROVIDERS.find(
            (info) => info.name.toLowerCase() === nameLower,
          );

        claimedIds.add(provider.id);
        claimedNames.add(nameLower);
        if (predefined) {
          claimedIds.add(predefined.id);
          claimedNames.add(predefined.name.toLowerCase());
        }

        return {
          info: predefined || {
            id: provider.id,
            name: provider.name,
            useApi: provider.useApi || false,
            defaultCommand: provider.command,
          },
          activeData: provider,
        };
      });

      PREDEFINED_PROVIDERS.forEach((info) => {
        if (claimedIds.has(info.id)) return;
        if (claimedNames.has(info.name.toLowerCase())) return;
        rows.push({ info, activeData: null });
      });

      rows.forEach((row) => group.add(createProviderRow(row.info, row.activeData)));

      // 3. Add Custom Provider Button
      addBtnRow = new Adw.ActionRow({
        title: _("Add Custom Provider"),
        subtitle: _("The extension should parse it correctly."),
      });

      const addBtn = new Gtk.Button({
        icon_name: "list-add-symbolic",
        valign: Gtk.Align.CENTER,
        css_classes: ["suggested-action"],
      });

      addBtn.connect("clicked", () => {
        const dialog = new Adw.MessageDialog({
          heading: _("New Provider"),
          body: _("Enter the details for your custom AI provider."),
          transient_for: this.get_root(),
          modal: true,
        });

        const content = new Gtk.Box({
          orientation: Gtk.Orientation.VERTICAL,
          spacing: 12,
        });

        const nameEntry = new Gtk.Entry({
          placeholder_text: _("Provider Name (e.g. MyLocalModel)"),
        });
        content.append(nameEntry);

        const cmdEntry = new Gtk.Entry({
          placeholder_text: _("Command (e.g. codexbar --provider ...)"),
        });
        content.append(cmdEntry);

        dialog.set_extra_child(content);
        dialog.add_response("cancel", _("Cancel"));
        dialog.add_response("add", _("Add"));
        dialog.set_response_appearance("add", Adw.ResponseAppearance.SUGGESTED);

        dialog.connect("response", (d, response) => {
          if (response === "add") {
            const name = nameEntry.get_text().trim();
            const cmd = cmdEntry.get_text().trim();
            if (name && cmd) {
              const newProvider = {
                id: `custom-${Date.now()}`,
                name: name,
                command: cmd,
                useApi: false,
              };
              const row = createProviderRow(
                {
                  id: newProvider.id,
                  name: newProvider.name,
                  useApi: false,
                  defaultCommand: newProvider.command,
                },
                newProvider,
              );
              // PreferencesGroup only appends, so the new row would land below
              // the "add" button; reapplying the order puts that button back
              // at the bottom where it belongs.
              group.add(row);
              applyRowOrder();
              saveProviders();
            }
          }
        });
        dialog.present();
      });

      addBtnRow.add_suffix(addBtn);
      group.add(addBtnRow);

      // Every row exists by now, so a lone provider correctly gets no handle.
      refreshHandles();

      return group;
    }

    /**
     * Build the maintenance/debug group.
     * Construye el grupo de mantenimiento/depuración.
     */
    _buildMaintenanceGroup() {
      const group = new Adw.PreferencesGroup({
        title: _("Maintenance"),
      });

      const setupBtnRow = new Adw.ActionRow({
        title: _("Show Welcome Screen"),
        subtitle: _("Reset first-run state"),
      });
      const setupBtn = new Gtk.Button({
        icon_name: "help-about-symbolic",
        valign: Gtk.Align.CENTER,
      });
      setupBtn.connect("clicked", () => {
        this._settings.set_boolean("first-run", true);
      });
      setupBtnRow.add_suffix(setupBtn);
      group.add(setupBtnRow);

      return group;
    }

    /**
     * Import cookies from browser using local Python script.
     * Importa cookies desde el navegador usando un script de Python local.
     */
    /**
     * Import cookies from browser using local Python script.
     * Importa cookies desde el navegador usando un script de Python local.
     */
    async _importFromBrowser(providerId, tokenEntry, callback = null) {
      const finish = () => {
        if (callback) callback();
      };

      const showError = (title, message) => {
        const dialog = new Adw.MessageDialog({
          heading: title,
          body: message,
          transient_for: this.get_root(),
          modal: true,
        });
        dialog.add_response("ok", _("OK"));
        dialog.present();
        finish();
      };

      const showMissingDialog = () => {
        const dialog = new Adw.MessageDialog({
          heading: _("Cookie Importer Missing"),
          body: _(
            "To import cookies automatically from your browser, please install the python dependency by running:\n\npip install codexbar-cookie-importer",
          ),
          transient_for: this.get_root(),
          modal: true,
        });
        dialog.add_response("ok", _("OK"));
        dialog.present();
        finish();
      };

      // Find the executable binary or fallback to python module
      // Encontrar el binario ejecutable o recurrir al módulo python
      let argv = null;
      if (GLib.find_program_in_path("codexbar-cookie-importer")) {
        argv = ["codexbar-cookie-importer"];
      } else {
        const localBin = GLib.build_filenamev([
          GLib.get_home_dir(),
          ".local",
          "bin",
          "codexbar-cookie-importer",
        ]);
        if (GLib.file_test(localBin, GLib.FileTest.EXISTS)) {
          argv = [localBin];
        } else {
          // Try executing as module / Intentar ejecutar como módulo
          argv = ["/usr/bin/python3", "-m", "codexbar_cookie_importer"];
        }
      }

      if (providerId === "ollama") {
        argv.push("--provider", "ollama");
      }

      try {
        const proc = new Gio.Subprocess({
          argv: argv,
          flags:
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        });
        proc.init(null);

        const cancellable = new Gio.Cancellable();
        let timedOut = false;

        const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 15000, () => {
          timedOut = true;
          cancellable.cancel();
          proc.force_exit();
          showError(
            _("Timeout"),
            _(
              "The cookie importer is taking too long. Please ensure your browser is closed and try again.",
            ),
          );
          return GLib.SOURCE_REMOVE;
        });

        proc.communicate_utf8_async(null, cancellable, async (p, res) => {
          if (timeoutId > 0 && !timedOut) {
            GLib.source_remove(timeoutId);
          }

          try {
            const [success, stdout, stderr] = p.communicate_utf8_finish(res);

            if (timedOut) return;

            // If the module is not found, python returns exit code 1 or 2 and No module named in stderr
            // Si el módulo no se encuentra, python devuelve código de salida 1 o 2 y No module named en stderr
            if (
              !success &&
              stderr &&
              (stderr.includes("No module named") ||
                stderr.includes("No such file"))
            ) {
              showMissingDialog();
              return;
            }

            if (success && stdout) {
              const result = JSON.parse(stdout.trim());

              if (result.error === "DEPENDENCIES_MISSING") {
                showMissingDialog();
              } else if (result.error) {
                showError(_("Import Failed"), result.details || result.error);
              } else if (result.cookie_header) {
                tokenEntry.set_text(result.cookie_header);
                await storeToken(providerId, result.cookie_header);

                const toast = new Adw.Toast({
                  title: _("Cookies imported successfully!"),
                });
                this.get_root().add_toast(toast);
                finish();
              }
            } else {
              const err = stderr || _("The importer returned no data.");
              if (err.includes("No module named")) {
                showMissingDialog();
              } else {
                showError(_("Error"), err);
              }
            }
          } catch (e) {
            if (!timedOut) {
              // Check if it's a module not found issue
              if (e.message && e.message.includes("No module named")) {
                showMissingDialog();
              } else {
                console.error(e, "CodexBar: Error reading importer output");
                showError(_("Unexpected Error"), e.message);
              }
            }
          }
        });
      } catch (e) {
        console.error(e, "CodexBar: Error in _importFromBrowser");
        showMissingDialog();
      }
    }

  }
);

/**
 * Main preferences entry point.
 * Punto de entrada principal para las preferencias.
 */
export default class CodexBarPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();
    const page = new CodexBarPrefsPage(settings, this.path);
    window.add(page);

    // Null out token schema when preferences window is closed
    // Anular el esquema del token cuando se cierre la ventana de preferencias
    window.connect("destroy", () => {
      nullTokenSchema();
    });
  }
}
