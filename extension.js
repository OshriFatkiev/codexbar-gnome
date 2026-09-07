// This file contains the main skeleton of the extension. Is like the HTML ;)

import Gio from "gi://Gio";
import GLib from "gi://GLib";
import St from "gi://St";
import Clutter from "gi://Clutter";
import Pango from "gi://Pango";
import {
  Extension,
  gettext as _,
} from "resource:///org/gnome/shell/extensions/extension.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import {
  calculateUsagePace,
  deriveCreditsPercent,
  normalizeDetailSections,
  UsageApiClient,
} from "./usageApi.js";
import { loadToken, nullTokenSchema } from "./secret.js";

function logDev(msg) {
  console.log(`[CodexBar] ${msg}`);
}

/**
 * Set visibility only when it actually changes.
 *
 * Hiding and re-showing an actor forces a relayout, which resets measured
 * widths the panel bars are sized against. Assigning unconditionally on every
 * refresh made the bars twitch on each update.
 *
 * @param {Clutter.Actor} actor
 * @param {boolean} visible
 */
function setVisible(actor, visible) {
  if (actor && actor.visible !== visible) actor.visible = visible;
}

// Secondary text keeps the theme's foreground colour and is dimmed with actor
// opacity. St has no CSS `opacity`, and the shell dims text with per-theme
// `rgba()` foregrounds only because it ships separate light and dark
// stylesheets — an extension with a single stylesheet cannot.
const SECONDARY_TEXT_OPACITY = 200;

// When the panel collapses a provider to one window it shows the shortest one,
// unless a longer window has reached this much usage - at which point it is
// close enough to exhaustion to be worth taking the slot.
const PANEL_ESCALATE_USED_PERCENT = 95;

// Floor for the usage bars, so a short label like "5h 0%" still leaves a bar
// long enough to read a proportion off.
const PANEL_TRACK_MIN_WIDTH = 32;

// The bars are sized to this string rather than to whatever is on screen, so
// their length stays put as values change and one bar can be compared with
// another. Measured, not hardcoded in pixels, so it follows the font size.
// A longer label (a monthly window, say) still widens the bars rather than
// overhanging them - see _syncTrackWidths.
const PANEL_WIDEST_LABEL = "7d 100%";

/**
 * Build a dimmed secondary label.
 * @param {object} params Extra St.Label properties.
 * @returns {St.Label}
 */
function subtitleLabel(params) {
  const label = new St.Label({
    style_class: "codexbar-usage-subtitle",
    ...params,
  });
  label.opacity = SECONDARY_TEXT_OPACITY;
  return label;
}

/**
 * Main extension class for CodexBar.
 * Clase principal de la extensión para CodexBar.
 */
export default class CodexBarExtension extends Extension {
  /**
   * Called when the extension is enabled.
   * Se llama cuando la extensión se activa.
   */
  enable() {
    // Obtiene los ajustes
    this._settings = this.getSettings();
    this._apiClient = new UsageApiClient(this.path);
    this._copyTimeouts = [];

    // Main indicator button in the panel
    // El botón principal (el del uso)
    this._indicator = new PanelMenu.Button(0.0, _("CodexBar"), false);

    // Panel content: one group per provider shown, e.g. [logo] 5h 51% 7d 60%.
    this._panelBox = new St.BoxLayout({
      vertical: false,
      y_align: Clutter.ActorAlign.CENTER,
      style_class: "codexbar-panel-box",
    });
    // One group per provider shown, each holding a logo and up to two metrics
    // (a percentage with a thin bar beneath it). Groups are allocated lazily in
    // _ensurePanelGroups and reused, so a refresh never rebuilds actors.
    this._panelGroups = [];

    // Never shown: exists only so the bars can be sized to the widest label
    // that can occur rather than the widest currently on screen.
    this._panelMeasureLabel = new St.Label({
      style_class: "codexbar-panel-label",
      text: PANEL_WIDEST_LABEL,
      visible: false,
    });
    this._panelBox.add_child(this._panelMeasureLabel);

    // Shown until there is a provider to report on. Without it the button has
    // no contents on first run or with nothing configured, leaving nothing to
    // click - and the welcome screen that explains what to do next is behind
    // that click.
    this._panelFallbackIcon = new St.Icon({
      // In hicolor, so it resolves under any icon theme; the Adwaita set has
      // no system-monitor symbolic and Yaru-only names fall back to nothing.
      icon_name: "speedometer-symbolic",
      icon_size: 16,
      y_align: Clutter.ActorAlign.CENTER,
      style_class: "codexbar-panel-fallback",
    });
    this._panelBox.add_child(this._panelFallbackIcon);

    this._indicator.add_child(this._panelBox);

    // Header section of the popup menu
    // Sección de cabecera del menú desplegable (el que aparece cuando clicas)
    this._headerBox = new St.BoxLayout({
      style_class: "codexbar-header",
      vertical: false,
      x_expand: true,
    });
    this._headerTitle = new St.Label({
      text: _("CodexBar"),
      y_align: Clutter.ActorAlign.CENTER,
      x_expand: true,
    });
    this._headerBox.add_child(this._headerTitle);

    let refreshBtn = new St.Button({
      child: new St.Icon({ icon_name: "view-refresh-symbolic", icon_size: 16 }),
      style_class: "codexbar-header-button",
      y_align: Clutter.ActorAlign.CENTER,
    });
    refreshBtn.connect("clicked", () => this._refreshData());
    this._headerBox.add_child(refreshBtn);

    let settingsBtn = new St.Button({
      child: new St.Icon({
        icon_name: "preferences-system-symbolic",
        icon_size: 16,
      }),
      style_class: "codexbar-header-button",
      y_align: Clutter.ActorAlign.CENTER,
    });
    settingsBtn.connect("clicked", () => {
      this.openPreferences();
      this._indicator.menu.close();
    });
    this._headerBox.add_child(settingsBtn);

    this._indicator.menu.box.add_child(this._headerBox);
    this._indicator.menu.box.add_style_class_name("codexbar-popup");

    // Tabs for switching between different providers
    // Pestañas para cambiar entre diferentes proveedores
    this._tabsContainer = new St.BoxLayout({
      style_class: "codexbar-tabs-container",
      vertical: false,
    });
    this._indicator.menu.box.add_child(this._tabsContainer);

    // Main content area for usage stats
    // Área de contenido principal para las estadísticas de uso
    this._contentBox = new St.BoxLayout({
      vertical: true,
      style_class: "codexbar-usage-section",
    });
    this._indicator.menu.box.add_child(this._contentBox);

    // Sibling of the content box rather than a child of it, so its separator
    // spans the popup and it sits flush at the bottom edge.
    this._footerBox = new St.BoxLayout({
      vertical: false,
      x_expand: true,
      style_class: "codexbar-footer",
    });
    this._indicator.menu.box.add_child(this._footerBox);

    Main.panel.addToStatusArea(this.uuid, this._indicator);

    this._activeProviderIndex = 0;
    this._providersData = [];
    this._loading = false;
    this._cancellable = new Gio.Cancellable();

    // Standard signal handling
    // Manejo estándar de señales 
    this._settings.connectObject(
      "changed::providers", () => this._onSettingsChanged(),
      "changed::refresh-interval", () => this._onSettingsChanged(),
      "changed::display-mode", () => this._updateUI(),
      "changed::show-logos", () => this._updateUI(),
      "changed::panel-show-logo", () => this._updateUI(),
      "changed::panel-providers", () => this._updateUI(),
      "changed::show-pacing-info", () => this._updateUI(),
      "changed::show-provider-details", () => this._updateUI(),
      "changed::first-run", () => this._updateUI(),
      "changed::dev-custom-output-enabled", () => this._onSettingsChanged(),
      "changed::dev-custom-output-provider-name", () => this._onSettingsChanged(),
      "changed::dev-custom-output-json", () => this._onSettingsChanged(),
      this
    );
    this._onSettingsChanged();
  }

  /**
   * Called when the extension is disabled.
   * Se llama cuando la extensión se desactiva.
   */
  disable() {
    // Step 1: Clean up the API client
    // Paso 1: Limpiar el cliente de la API
    if (this._apiClient) {
      this._apiClient.destroy();
      this._apiClient = null;
    }

    // Step 2: Cancel any pending subprocesses or async operations
    // Paso 2: Cancelar cualquier subproceso o operación asíncrona pendiente
    if (this._cancellable) {
      this._cancellable.cancel();
      this._cancellable = null;
    }

    // Step 3: Remove timeouts
    // Paso 3: Eliminar los timeouts
    if (this._timeoutId) {
      GLib.source_remove(this._timeoutId);
      this._timeoutId = null;
    }
    if (this._copyTimeouts) {
      this._copyTimeouts.forEach((id) => GLib.source_remove(id));
      this._copyTimeouts = null;
    }

    // Step 4: Disconnect all settings signals
    // Paso 4: Desconectar todas las señales de configuración
    if (this._settings) {
      this._settings.disconnectObject(this);
      this._settings = null;
    }

    // Step 5: Destroy all UI elements and the indicator
    // Paso 5: Destruir todos los elementos de la interfaz y el indicador
    if (this._panelGroups) {
      this._panelGroups.forEach((g) => g.box.destroy());
      this._panelGroups = null;
    }
    this._panelMeasureLabel = null;
    this._panelFallbackIcon = null;
    if (this._panelBox) {
      this._panelBox.destroy();
      this._panelBox = null;
    }
    if (this._headerTitle) {
      this._headerTitle.destroy();
      this._headerTitle = null;
    }
    if (this._headerBox) {
      this._headerBox.destroy();
      this._headerBox = null;
    }
    if (this._tabsContainer) {
      this._tabsContainer.destroy();
      this._tabsContainer = null;
    }
    if (this._contentBox) {
      this._contentBox.destroy();
      this._contentBox = null;
    }
    if (this._footerBox) {
      this._footerBox.destroy();
      this._footerBox = null;
    }
    if (this._indicator) {
      this._indicator.destroy();
      this._indicator = null;
    }

    // Step 6: Nullify remaining references to prevent memory leaks
    // Paso 6: Anular referencias restantes para prevenir fugas de memoria
    this._providersData = [];
    this._activeProviderIndex = 0;

    // Step 7: Release schema references to prevent memory leaks
    // Paso 7: Liberar referencias de esquemas para prevenir fugas de memoria
    nullTokenSchema();

  }

  /**
   * Handle settings changes.
   * Manejar cambios en la configuración.
   */
  _onSettingsChanged() {
    const providersJson = this._settings.get_string("providers");
    try {
      this._providers = JSON.parse(providersJson);
    } catch (e) {
      this._providers = [];
      console.error(e, "CodexBar: Failed to parse providers");
    }

    if (this._activeProviderIndex >= this._providers.length) {
      this._activeProviderIndex = 0;
    }

    this._refreshData();
    this._setupTimeout();
  }

  /**
   * Set up the auto-refresh timer.
   * Configura el temporizador de refresco automático.
   */
  _setupTimeout() {
    if (this._timeoutId) {
      GLib.source_remove(this._timeoutId);
    }
    const interval = this._settings.get_int("refresh-interval") * 60 * 1000;
    if (interval > 0) {
      this._timeoutId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        interval,
        () => {
          this._refreshData();
          return GLib.SOURCE_CONTINUE;
        },
      );
    }
  }

 

  /**
   * Refresh usage data for all enabled providers.
   * Refrescar los datos de uso para todos los proveedores habilitados.
   */
  async _refreshData() {
    if (this._loading || this._providers.length === 0) return;
    this._loading = true;

    if (this._headerTitle)
      this._headerTitle.set_text(_("CodexBar (Refreshing...)"));

    logDev("Refreshing usage data...");

    // Intercept if developer custom output simulation is active
    if (this._settings.get_boolean("dev-custom-output-enabled")) {
      const mockName = this._settings.get_string("dev-custom-output-provider-name") || "Mock Provider";
      const mockJson = this._settings.get_string("dev-custom-output-json") || "[]";
      logDev(`[Dev Mode] Simulating custom output for provider: ${mockName}`);
      logDev(`[Dev Mode] Input payload: ${mockJson}`);

      this._providersData = [];
      try {
        const parsed = JSON.parse(mockJson);
        let rawData = Array.isArray(parsed) ? parsed[0] : parsed;
        let finalLabels = [];

        if (rawData) {
          const isAntigravity = mockName.toLowerCase() === "antigravity" || rawData.provider === "antigravity";
          
          if (rawData.usage) {
            logDev(`[Dev Mode] Normalizing nested usage object...`);
            const normalized = this._apiClient.normalizeSummary(
              rawData.usage,
              isAntigravity,
            );
            rawData.usage = normalized.usage;
            finalLabels = normalized.labels || [];
          } else {
            logDev(`[Dev Mode] Normalizing flat usage object...`);
            const normalized = this._apiClient.normalizeSummary(
              rawData,
              isAntigravity,
            );
            rawData = { ...rawData, usage: normalized.usage };
            finalLabels = normalized.labels || [];
          }
        }

        this._providersData[0] = {
          data: rawData,
          labels: finalLabels,
          command: "mock-command",
        };

        this._providers = [{
          id: "mock-provider",
          name: mockName,
          useApi: false,
          command: "mock-command",
        }];
        this._activeProviderIndex = 0;
        logDev(`[Dev Mode] Successfully simulated custom output. Labels: [${finalLabels.join(", ")}]`);
      } catch (error) {
        logDev(`[Dev Mode] Error parsing/normalizing mock output: ${error.message}`);
        this._providersData[0] = {
          error: error.message,
          command: "mock-command",
        };
        this._providers = [{
          id: "mock-provider",
          name: mockName,
          useApi: false,
          command: "mock-command",
        }];
        this._activeProviderIndex = 0;
      }

      this._loading = false;
      if (this._headerTitle) this._headerTitle.set_text(_("CodexBar"));
      this._updateUI();
      return;
    }

    this._providersData = [];

    for (let i = 0; i < this._providers.length; i++) {
      const provider = this._providers[i];

      if (provider.useApi) {
        logDev(`Fetching API summary for provider: ${provider.name}`);
        try {
          let data;
          const token = await loadToken(provider.id);
          if (!token) {
            logDev(`Error: No token found in keyring for provider: ${provider.name}`);
            this._providersData[i] = { error: _("No token found in keyring") };
            continue;
          }
          data = await this._apiClient.fetchSummary(token, provider.id, this._cancellable);

          // Generate dynamic labels based on window durations
          // Generar etiquetas dinámicas basadas en las duraciones de las ventanas
          let apiLabels = [];
          if (data.labels && data.labels.length > 0) {
            apiLabels = data.labels;
          } else {
            ["primary", "secondary", "tertiary", "quaternary"].forEach(
              (tier) => {
                const win = data.usage[tier];
                if (win && win.windowSeconds) {
                  const hours = Math.round(win.windowSeconds / 3600);
                  if (hours >= 24) {
                    const days = Math.round(hours / 24);
                    apiLabels.push(
                      days === 7
                        ? _("Weekly Window")
                        : _("%d-Day Window").format(days),
                    );
                  } else {
                    apiLabels.push(_("%d-Hour Window").format(hours));
                  }
                } else if (win) {
                  apiLabels.push(_("Usage Window"));
                }
              },
            );
          }

          this._providersData[i] = {
            data: data,
            labels: apiLabels,
          };
          logDev(`Successfully fetched API data for provider: ${provider.name}`);
        } catch (error) {
          logDev(`API error for provider ${provider.name}: ${error.message || error}`);
          console.error(error, `CodexBar: API error for ${provider.name}`);
          let msg = error.message;
          if (!msg && error.toString) msg = error.toString();
          if (!msg || msg === "[object Object]") msg = _("Unknown API error");
          this._providersData[i] = { error: msg };
        }
        continue;
      }

      // Case 2: Provider uses CLI command (external codexbar tool)
      // Caso 2: El proveedor usa un comando CLI (herramienta codexbar externa)
      if (!provider.command) {
        logDev(`Error: No CLI command configured for provider: ${provider.name}`);
        this._providersData[i] = { error: _("No command configured") };
        continue;
      }

      logDev(`Executing CLI command for provider ${provider.name}: ${provider.command}`);
      try {
        const result = await this._apiClient.fetchCliSummary(
          provider.command,
          this._cancellable,
        );
        if (!this._cancellable || this._cancellable.is_cancelled()) {
          logDev(`CLI execution cancelled for provider: ${provider.name}`);
          // Clear the guard on the way out: leaving it set would make every
          // later _refreshData return at the top, silently freezing both the
          // data and the UI until the extension is re-enabled.
          this._loading = false;
          return;
        }

        let rawData = result.data;
        let finalLabels = result.labels || [];

        if (rawData) {
          const isAntigravity =
            provider.id === "antigravity" || rawData.provider === "antigravity";

          if (rawData.usage) {
            const normalized = this._apiClient.normalizeSummary(
              rawData.usage,
              isAntigravity,
            );
            rawData.usage = normalized.usage;
            if (normalized.labels && normalized.labels.length > 0) {
              finalLabels = normalized.labels;
            }
          } else {
            const normalized = this._apiClient.normalizeSummary(
              rawData,
              isAntigravity,
            );
            rawData = { ...rawData, usage: normalized.usage };
            if (normalized.labels && normalized.labels.length > 0) {
              finalLabels = normalized.labels;
            }
          }
        }

        this._providersData[i] = {
          data: rawData,
          labels: finalLabels,
          command: result.command,
        };
        logDev(`Successfully executed CLI command for provider: ${provider.name}`);
      } catch (error) {
        if (this._cancellable && !this._cancellable.is_cancelled()) {
          logDev(`CLI error for provider ${provider.name}: ${error.message || error}`);
          console.error(
            error,
            `CodexBar: error running provider ${provider.name}`,
          );
          let msg = error.message;
          if (!msg && error.toString) msg = error.toString();
          if (!msg || msg === "[object Object]") msg = _("Unknown CLI error");
          this._providersData[i] = {
            error: msg,
            command: provider.command,
          };
        }
      }
    }

    // Released unconditionally: only the UI refresh is worth skipping when the
    // run was cancelled, and holding the guard would freeze every later run.
    this._loading = false;
    if (this._cancellable && !this._cancellable.is_cancelled()) {
      if (this._headerTitle) this._headerTitle.set_text(_("CodexBar"));
      this._updateUI();
    }
  }

  /**
   * Normalize percentage value.
   * Normaliza el valor del porcentaje.
   */
  _normalizePercent(value) {
    if (value === undefined || value === null) return 0;
    let p = parseFloat(value);
    return Math.min(100, Math.max(0, p));
  }

  /**
   * Check if a binary exists in the PATH or standard directories.
   * Comprueba si existe un binario en el PATH o en directorios estándar.
   */
  _checkBinaryExists(name) {
    if (GLib.find_program_in_path(name)) {
      return true;
    }
    const commonPaths = [
      `/home/linuxbrew/.linuxbrew/bin/${name}`,
      `${GLib.get_home_dir()}/.local/bin/${name}`,
      `/usr/local/bin/${name}`,
      `/usr/bin/${name}`,
    ];
    for (const path of commonPaths) {
      if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Update the indicator menu UI.
   * Actualiza la interfaz del menú del indicador.
   */
  _updateUI() {
    if (!this._indicator) return;

    this._tabsContainer.destroy_all_children();
    this._contentBox.destroy_all_children();
    this._footerBox.destroy_all_children();
    // Shown again only when there is a timestamp to put in it, so the
    // separator never appears above an empty strip.
    setVisible(this._footerBox, false);

    const displayMode = this._settings.get_string("display-mode");
    const firstRun = this._settings.get_boolean("first-run");

    // Check for CLI and Cookie Importer presence
    // Comprobar la presencia de la CLI y del importador de cookies
    const codexbarExists = this._checkBinaryExists("codexbar");
    const importerExists = this._checkBinaryExists("codexbar-cookie-importer");

    if (firstRun || !codexbarExists) {
      this._showWelcomeScreen(codexbarExists, importerExists);
      return;
    }

    const activeData = this._providersData[this._activeProviderIndex];
    // A tier with usedPercent:0 and no windowSeconds isn't a real usage window
    // (e.g. OpenRouter's balance placeholder) - derive a meaningful percent from
    // the Credits detail section instead, or drop the tier if none is available.
    const creditsPercent = deriveCreditsPercent(
      normalizeDetailSections(activeData?.data?.usage?.details),
    );
    const isDegenerateTier = (tierData) =>
      !!tierData && !tierData.windowSeconds && tierData.usedPercent === 0;

    // Create tab buttons
    // Crear botones de pestaña
    const showLogos = this._settings.get_boolean("show-logos");

    this._providers.forEach((provider, index) => {
      let btn = new St.Button({
        style_class: "codexbar-tab",
        can_focus: true,
      });

      let btnBin = new St.BoxLayout({
        vertical: false,
        y_align: Clutter.ActorAlign.CENTER,
      });
      btn.set_child(btnBin);

      if (showLogos) {
        const logoIcon = this._getProviderLogo(
          provider.id || provider.name.toLowerCase(),
        );
        if (logoIcon) {
          btnBin.add_child(logoIcon);
        }
      }

      btnBin.add_child(
        new St.Label({
          text: provider.name || _("Unknown"),
          y_align: Clutter.ActorAlign.CENTER,
        }),
      );

      if (index === this._activeProviderIndex) {
        btn.add_style_class_name("codexbar-tab-active");
      }
      btn.connect("clicked", () => {
        this._activeProviderIndex = index;
        this._updateUI();
      });
      this._tabsContainer.add_child(btn);
    });

    this._updatePanel(displayMode);

    if (this._providers.length === 0) {
      this._contentBox.add_child(
        new St.Label({ text: _("No providers configured. Click settings.") }),
      );
      return;
    }

    const activeProvider = this._providers[this._activeProviderIndex];
    // Reuse activeData already declared above
    // Reutilizar activeData ya declarada arriba

    if (!activeData) {
      this._contentBox.add_child(new St.Label({ text: _("Loading data...") }));
      return;
    }

    // Show error if any
    // Mostrar error si existe
    if (activeData.error) {
      let errorBox = new St.BoxLayout({ vertical: true, x_expand: true });

      let title = new St.Label({
        text: _("Error: %s").format(activeData.error),
        style: "color: #ff7800; font-weight: bold; margin-bottom: 10px;",
      });
      errorBox.add_child(title);

      if (activeData.stderr) {
        errorBox.add_child(
          new St.Label({
            text: _("Stderr:"),
            style: "font-weight: bold; font-size: 0.8em; margin-top: 5px;",
          }),
        );
        let scroll = new St.ScrollView({
          hscrollbar_policy: St.PolicyType.AUTOMATIC,
          vscrollbar_policy: St.PolicyType.NEVER,
          style:
            "background-color: rgba(0,0,0,0.2); border-radius: 4px; padding: 5px;",
        });
        scroll.add_child(
          new St.Label({
            text: activeData.stderr,
            style: "font-family: monospace; font-size: 0.8em;",
          }),
        );
        errorBox.add_child(scroll);
      }

      this._contentBox.add_child(errorBox);
      return;
    }

    const data = activeData.data;
    if (!data || !data.usage) {
      this._contentBox.add_child(
        new St.Label({ text: _("Invalid JSON format (missing usage)") }),
      );
      return;
    }

    const usage = data.usage;
    const showPacing = this._settings.get_boolean("show-pacing-info");

    // Account information
    // Información de la cuenta
    if (usage.accountEmail) {
      let accountBox = new St.BoxLayout({ vertical: true, margin_bottom: 15 });
      accountBox.add_child(
        new St.Label({
          text: activeProvider.name,
          style_class: "codexbar-usage-title",
          style: "font-size: 1.1em;",
        }),
      );
      let accText = usage.accountEmail;
      if (usage.loginMethod) accText += ` (${usage.loginMethod})`;
      const accountDetails = new St.BoxLayout({
        vertical: false,
        x_expand: true,
      });
      accountDetails.add_child(subtitleLabel({ text: accText }));
      if (usage.planType) {
        const planText =
          usage.planType.charAt(0).toUpperCase() + usage.planType.slice(1);
        accountDetails.add_child(
          subtitleLabel({
            text: planText,
            x_align: Clutter.ActorAlign.END,
            x_expand: true,
          }),
        );
      }
      accountBox.add_child(accountDetails);

      this._contentBox.add_child(accountBox);
    }

    this._renderDetailSections(usage);

    // Usage bars for each tier
    // Barras de uso para cada nivel
    const tiers = ["primary", "secondary", "tertiary", "quaternary"];
    const discoveredLabels = activeData.labels || [];
    let hasTiers = false;

    const usageEntries = tiers.map((tier, tierIdx) => {
      let tierData = usage[tier];
      let title =
        discoveredLabels[tierIdx] ||
        tier.charAt(0).toUpperCase() + tier.slice(1);

      if (isDegenerateTier(tierData)) {
        if (creditsPercent === null) {
          tierData = null;
        } else {
          tierData = { ...tierData, usedPercent: creditsPercent };
          title = _("Credits");
        }
      }

      return { data: tierData, showPace: true, title };
    });
    usageEntries.push({
      data: usage.codeReview,
      showPace: false,
      title: _("Code review"),
    });

    usageEntries.forEach((entry) => {
      if (entry.data && entry.data.usedPercent !== undefined) {
        hasTiers = true;
        let tierData = entry.data;

        this._contentBox.add_child(
          new St.Label({
            text: entry.title,
            style_class: "codexbar-usage-title",
          }),
        );

        let progressContainer = new St.BoxLayout({
          style_class: "codexbar-progress-container",
        });
        let p = this._normalizePercent(tierData.usedPercent);

        let percent = displayMode === "remaining" ? 100 - p : p;
        let labelText =
          displayMode === "remaining"
            ? _("%s%% left").format(percent.toFixed(1))
            : _("%s%% used").format(percent.toFixed(1));

        let color = "#3584e4";
        if (displayMode === "remaining") {
          if (percent < 10) color = "#e01b24";
          else if (percent < 25) color = "#ff7800";
          else if (percent < 50) color = "#f6d32d";
        } else {
          if (percent > 90) color = "#e01b24";
          else if (percent > 75) color = "#ff7800";
          else if (percent > 50) color = "#f6d32d";
        }

        const fullWidth = 290;
        const barWidth = Math.max(1, Math.round((percent / 100) * fullWidth));

        let progressBar = new St.Widget({
          style_class: "codexbar-progress-bar",
          style: `width: ${barWidth}px; background-color: ${color};`,
        });
        progressContainer.add_child(progressBar);
        this._contentBox.add_child(progressContainer);

        const statsBox = new St.BoxLayout({ vertical: false, x_expand: true });
        statsBox.add_child(subtitleLabel({ text: labelText }));
        statsBox.add_child(
          subtitleLabel({
            text: tierData.resetDescription || "",
            x_align: Clutter.ActorAlign.END,
            x_expand: true,
          }),
        );

        this._contentBox.add_child(statsBox);

        if (showPacing && entry.showPace && tierData.windowSeconds >= 7 * 24 * 3600) {
          const pace = calculateUsagePace(tierData);
          if (pace) {
            const roundedReserve = Math.round(pace.reservePercent);
            const paceBox = new St.BoxLayout({ vertical: false, x_expand: true });
            paceBox.add_child(
              subtitleLabel({
                text:
                  roundedReserve >= 0
                    ? _("%d%% in reserve").format(roundedReserve)
                    : _("%d%% over pace").format(Math.abs(roundedReserve)),
              }),
            );
            paceBox.add_child(
              subtitleLabel({
                text:
                  roundedReserve >= 0
                    ? _("Lasts until reset")
                    : _("May run out before reset"),
                x_align: Clutter.ActorAlign.END,
                x_expand: true,
              }),
            );
            this._contentBox.add_child(paceBox);
          }
        }

        let sep = new St.Widget({
          style:
            "height: 1px; background-color: rgba(255,255,255,0.05); margin-bottom: 10px; margin-top: 5px;",
        });
        this._contentBox.add_child(sep);
      }
    });

    if (usage.rateLimitResetCredits?.availableCount !== undefined) {
      const creditCount = usage.rateLimitResetCredits.availableCount;
      const creditsBox = new St.BoxLayout({
        vertical: true,
        style_class: "codexbar-reset-credits",
        x_expand: true,
      });
      creditsBox.add_child(
        new St.Label({
          text: _("Limit reset credits"),
          style_class: "codexbar-usage-title",
        }),
      );
      creditsBox.add_child(
        subtitleLabel({
          text:
            creditCount === 1
              ? _("1 available")
              : _("%d available").format(creditCount),
        }),
      );
      this._contentBox.add_child(creditsBox);
    }

    if (!hasTiers && usage.providerCost) {
      let costBox = new St.BoxLayout({
        vertical: true,
        style_class: "codexbar-cost-container",
        x_expand: true,
      });

      let costTitleStr = usage.providerCost.period || _("Balance");
      let costTitle = new St.Label({
        text: costTitleStr,
        style_class: "codexbar-cost-title",
        x_align: Clutter.ActorAlign.CENTER,
      });
      costTitle.opacity = SECONDARY_TEXT_OPACITY;
      costBox.add_child(costTitle);

      let formattedAmount = "";
      try {
        let currency = usage.providerCost.currencyCode || "USD";
        let used = usage.providerCost.used || 0;
        let limit = usage.providerCost.limit || 0;
        let formatter = new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: currency,
        });
        if (limit > 0) {
          formattedAmount = `${formatter.format(used)} / ${formatter.format(limit)}`;
        } else {
          formattedAmount = formatter.format(used);
        }
      } catch (e) {
        let currencySymbol = usage.providerCost.currencyCode === "USD" ? "$" : (usage.providerCost.currencyCode || "");
        let used = usage.providerCost.used || 0;
        let limit = usage.providerCost.limit || 0;
        if (limit > 0) {
          formattedAmount = `${currencySymbol}${used.toFixed(2)} / ${currencySymbol}${limit.toFixed(2)}`;
        } else {
          formattedAmount = `${currencySymbol}${used.toFixed(2)}`;
        }
      }

      let costValue = new St.Label({
        text: formattedAmount,
        style_class: "codexbar-cost-value",
        x_align: Clutter.ActorAlign.CENTER,
      });
      costBox.add_child(costValue);

      this._contentBox.add_child(costBox);
    }

    this._renderUpdatedAt(usage);
  }

  /**
   * Render the fetch timestamp as a footer.
   *
   * It describes when this tab's data was fetched rather than the account
   * above it, so it belongs after the usage rather than in the identity block
   * where it used to sit.
   *
   * @param {object} usage
   */
  _renderUpdatedAt(usage) {
    if (!usage?.updatedAt) return;

    const date = new Date(usage.updatedAt);
    if (Number.isNaN(date.getTime())) return;

    this._footerBox.add_child(
      subtitleLabel({
        text: _("Updated %s").format(
          date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        ),
      }),
    );
    setVisible(this._footerBox, true);
  }

  /**
   * Render provider-supplied detail sections (codexbar `usage.details`).
   * @param {object} usage
   */
  _renderDetailSections(usage) {
    if (!this._settings.get_boolean("show-provider-details")) return;

    const sections = normalizeDetailSections(usage?.details);
    if (sections.length === 0) return;

    const detailsBox = new St.BoxLayout({
      vertical: true,
      style_class: "codexbar-details-section",
      x_expand: true,
    });

    sections.forEach((section) => {
      const groupBox = new St.BoxLayout({
        vertical: true,
        style_class: "codexbar-detail-group",
        x_expand: true,
      });

      if (section.title) {
        groupBox.add_child(
          new St.Label({
            text: section.title,
            style_class: "codexbar-detail-title",
          }),
        );
      }

      section.rows.forEach((row) => {
        const rowBox = new St.BoxLayout({ vertical: false, x_expand: true });

        const labelWidget = new St.Label({
          text: row.label,
          style_class: "codexbar-detail-label",
        });
        labelWidget.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        labelWidget.opacity = 200;
        rowBox.add_child(labelWidget);

        const valueWidget = new St.Label({
          text: row.value,
          style_class: "codexbar-detail-value",
          x_align: Clutter.ActorAlign.END,
          x_expand: true,
        });
        valueWidget.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        rowBox.add_child(valueWidget);

        groupBox.add_child(rowBox);

        if (row.secondaryValue) {
          const noteWidget = new St.Label({
            text: row.secondaryValue,
            style_class: "codexbar-detail-note",
          });
          noteWidget.clutter_text.line_wrap = true;
          noteWidget.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
          noteWidget.opacity = 160;
          groupBox.add_child(noteWidget);
        }
      });

      detailsBox.add_child(groupBox);
    });

    this._contentBox.add_child(detailsBox);
  }

  /**
   * Build one panel metric: a percentage label with a thin bar under it.
   *
   * The track has a fixed width from the stylesheet so every bar shares a 100%
   * reference. That width still isn't known until allocation, so the fill is
   * resized from the allocation notify rather than at construction.
   *
   * @returns {{box: St.BoxLayout, label: St.Label, track: St.BoxLayout, fill: St.Widget, percent: number}}
   */
  _buildPanelMetric() {
    const box = new St.BoxLayout({
      vertical: true,
      y_align: Clutter.ActorAlign.CENTER,
      style_class: "codexbar-panel-metric",
    });
    const label = new St.Label({ style_class: "codexbar-panel-label" });
    const track = new St.BoxLayout({
      style_class: "codexbar-panel-track",
      // Not x_expand: the track takes its fixed width from the stylesheet so
      // every bar means the same thing, rather than stretching to its label.
      x_expand: false,
      x_align: Clutter.ActorAlign.START,
    });
    const fill = new St.Widget({
      style_class: "codexbar-panel-track-fill",
      x_expand: false,
      width: 0,
    });
    track.add_child(fill);
    box.add_child(label);
    box.add_child(track);

    const metric = { box, label, track, fill, percent: 0 };
    // On allocation, not notify::width: re-showing a hidden group reallocates
    // to the same width, so a width notify never fires and a fill sized against
    // the stale width would stick.
    track.connect("notify::allocation", () => this._applyMetricFill(metric));
    // Recolour when the shell theme changes (light/dark switch), which need not
    // move the allocation.
    label.connect("style-changed", () => this._applyMetricFill(metric));
    return metric;
  }

  /**
   * Size a metric's fill to its track's current width, and colour it to match
   * the panel's own text.
   *
   * The colour is read from the label's resolved theme node rather than set in
   * the stylesheet: St has no way to inherit a colour into a background, and
   * the accent-colour setting only exists from GNOME 47. Reading the theme node
   * works on any shell theme, light or dark, with no version check.
   *
   * @param {object} metric
   */
  _applyMetricFill(metric) {
    if (!metric || !metric.track || !metric.fill) return;
    const trackWidth = metric.track.get_width();
    if (trackWidth <= 0) return;
    // Keep a sliver visible above 0% so a barely-used window still reads.
    const target =
      metric.percent > 0
        ? Math.max(1, Math.round((metric.percent / 100) * trackWidth))
        : 0;
    // Only assign on a real change: this runs from an allocation notify, and
    // an unconditional set_width would relayout forever.
    if (metric.fill.get_width() !== target) metric.fill.set_width(target);

    const style = this._metricFillStyle(metric);
    if (style && metric.fillStyle !== style) {
      metric.fillStyle = style;
      metric.fill.set_style(style);
    }
  }

  /**
   * Inline style giving the fill the label's foreground colour.
   * @param {object} metric
   * @returns {string|null} Null before the label has a resolved theme node.
   */
  _metricFillStyle(metric) {
    let colour = null;
    try {
      colour = metric.label.get_theme_node().get_foreground_color();
    } catch (e) {
      // Thrown while the actor is unmapped and has no theme node yet; the
      // allocation notify will bring us back here once it does.
      return null;
    }
    if (!colour) return null;
    return `background-color: rgba(${colour.red}, ${colour.green}, ${colour.blue}, 0.85);`;
  }

  /**
   * Short label for a usage window, e.g. 18000 -> "5h", 604800 -> "7d".
   * @param {number} windowSeconds
   * @returns {string|null}
   */
  _windowShortLabel(windowSeconds) {
    if (!windowSeconds || windowSeconds <= 0) return null;
    const hours = Math.round(windowSeconds / 3600);
    if (hours < 24) return `${hours}h`;
    return `${Math.round(hours / 24)}d`;
  }

  /**
   * The usage windows a provider contributes to the panel.
   *
   * Only the two canonical windows are considered; anything further stays in
   * the popup, where there is room to name it.
   *
   * When `limit` is 1, the shortest window wins. It is the one that stops you
   * mid-task, and keeping the field on a fixed window means a glance doesn't
   * have to re-read which one it is. Ranking the windows by percentage instead
   * would compare quantities that aren't comparable - 28% of a week and 3% of
   * five hours don't measure the same thing.
   *
   * The exception is a longer window at or past PANEL_ESCALATE_USED_PERCENT,
   * which is close enough to exhaustion to be worth interrupting for.
   *
   * @param {object} providerData Entry from _providersData.
   * @param {string} displayMode "used" or "remaining".
   * @param {number} limit Maximum windows to return.
   * @returns {Array<{label: string, percent: number}>}
   */
  _panelWindows(providerData, displayMode, limit) {
    const usage = providerData?.data?.usage;
    const windows = [];

    ["primary", "secondary"].forEach((tier) => {
      const win = usage?.[tier];
      if (!win || win.usedPercent === undefined) return;
      const label = this._windowShortLabel(win.windowSeconds);
      if (!label) return;
      const used = this._normalizePercent(win.usedPercent);
      windows.push({
        label,
        used,
        windowSeconds: win.windowSeconds,
        percent: displayMode === "remaining" ? 100 - used : used,
      });
    });

    if (windows.length <= limit) return windows;

    windows.sort((a, b) => a.windowSeconds - b.windowSeconds);
    const escalated = windows
      .slice(limit)
      .filter((w) => w.used >= PANEL_ESCALATE_USED_PERCENT)
      .sort((a, b) => b.used - a.used);

    return escalated.length > 0
      ? escalated.slice(0, limit)
      : windows.slice(0, limit);
  }

  /**
   * Grow the panel group pool to `count` and hide the rest.
   *
   * Groups are reused across refreshes so a refresh never rebuilds actors;
   * only a change in provider count allocates.
   *
   * @param {number} count
   */
  _ensurePanelGroups(count) {
    while (this._panelGroups.length < count) {
      const box = new St.BoxLayout({
        vertical: false,
        y_align: Clutter.ActorAlign.CENTER,
        style_class: "codexbar-panel-group",
      });
      const logoBin = new St.Bin({
        y_align: Clutter.ActorAlign.CENTER,
        style_class: "codexbar-panel-logo",
      });
      const metrics = [this._buildPanelMetric(), this._buildPanelMetric()];
      box.add_child(logoBin);
      metrics.forEach((m) => box.add_child(m.box));

      this._panelGroups.push({ box, logoBin, metrics });
      this._panelBox.add_child(box);
    }
  }

  /**
   * Populate one panel group with a provider's logo and windows.
   * @param {number} index Group index.
   * @param {{provider: object, windows: Array}} entry
   */
  _fillPanelGroup(index, entry) {
    const group = this._panelGroups[index];
    if (!group) return;

    const showLogo = this._settings.get_boolean("panel-show-logo");
    setVisible(group.box, true);

    // Only swap the icon when the provider actually changed: rebuilding it
    // every refresh reallocates the row for no reason.
    const logoId =
      showLogo && entry.provider
        ? entry.provider.id || entry.provider.name.toLowerCase()
        : null;
    if (group.logoId !== logoId) {
      group.logoId = logoId;
      group.logoBin.set_child(null);
      const logo = logoId ? this._getProviderLogo(logoId) : null;
      if (logo) group.logoBin.set_child(logo);
      setVisible(group.logoBin, !!logo);
    }

    group.metrics.forEach((metric, i) => {
      const win = entry.windows[i];
      setVisible(metric.box, !!win);
      if (!win) return;
      const text = `${win.label} ${Math.round(win.percent)}%`;
      if (metric.label.get_text() !== text) metric.label.set_text(text);
      metric.percent = win.percent;
      this._applyMetricFill(metric);
    });

    // A provider with no usable windows still shows its logo, so a failed
    // fetch reads as "no data" rather than the provider silently vanishing.
    if (entry.windows.length === 0) {
      const metric = group.metrics[0];
      setVisible(metric.box, true);
      if (metric.label.get_text() !== "—") metric.label.set_text("—");
      metric.percent = 0;
      this._applyMetricFill(metric);
    }
  }

  /**
   * Update the panel indicator: each provider's logo and window percentages.
   *
   * Each usage window is shown separately rather than averaged - an exhausted
   * 5h window shouldn't be hidden behind a healthy weekly one.
   *
   * @param {string} displayMode "used" or "remaining".
   */
  _updatePanel(displayMode) {
    // _updateUI can be reached with nothing configured, via a settings watcher
    // rather than a refresh.
    setVisible(this._panelFallbackIcon, this._providers.length === 0);

    const showAll =
      this._settings.get_string("panel-providers") === "all" &&
      this._providers.length > 1;

    // Active provider only: both windows. All providers: each collapsed to
    // its most-constrained window, so breadth costs one field per provider.
    const entries = showAll
      ? this._providers.map((provider, i) => ({
          provider,
          windows: this._panelWindows(this._providersData[i], displayMode, 1),
        }))
      : [
          {
            provider: this._providers[this._activeProviderIndex],
            windows: this._panelWindows(
              this._providersData[this._activeProviderIndex],
              displayMode,
              2,
            ),
          },
        ];

    this._ensurePanelGroups(entries.length);
    this._panelGroups.forEach((group, i) => {
      if (i < entries.length) this._fillPanelGroup(i, entries[i]);
      else setVisible(group.box, false);
    });
    this._syncTrackWidths();
  }

  /**
   * Give every visible track the width of the widest visible label.
   *
   * The width comes from PANEL_WIDEST_LABEL rather than the labels currently
   * shown, so it is comparable between bars, never overhung by its text, and
   * stable as values change. A label wider than that baseline still wins, so
   * an unexpected window length widens the bars instead of spilling over.
   */
  _syncTrackWidths() {
    if (!this._panelGroups) return;


    const tracks = [];
    // Baseline is the worst-case label, so the width does not move as values
    // change; a longer label than expected still wins, to avoid overhang.
    let widest = 0;
    if (this._panelMeasureLabel) {
      // Force style resolution first: an actor that has never been mapped can
      // otherwise report a width computed at the default font rather than the
      // 0.9em the stylesheet gives it, making every bar wider than its text.
      this._panelMeasureLabel.ensure_style();
      widest = this._panelMeasureLabel.get_preferred_width(-1)[1];
    }
    this._panelGroups.forEach((group) => {
      if (!group.box.visible) return;
      group.metrics.forEach((metric) => {
        if (!metric.box.visible) return;
        // Preferred width, not allocated: this runs before layout, and asking
        // for the allocation here would size against the previous text.
        const [, natural] = metric.label.get_preferred_width(-1);
        widest = Math.max(widest, natural);
        tracks.push(metric.track);
      });
    });

    if (widest <= 0) return;
    const width = Math.round(Math.max(PANEL_TRACK_MIN_WIDTH, widest));
    tracks.forEach((track) => {
      if (track.get_width() !== width) track.set_width(width);
    });
  }

  /**
   * Get provider logo as an St.Icon.
   * Obtener el logo del proveedor como un St.Icon.
   * @param {string} providerId
   * @returns {St.Icon|null}
   */
  _getProviderLogo(providerId) {
    if (!providerId) return null;

    // Normalize ID: lowercase and replace spaces with dashes
    const id = providerId.toLowerCase().replace(/\s+/g, "-");
    const logoPath = GLib.build_filenamev([
      this.path,
      "media",
      "logos",
      `${id}-symbolic.svg`,
    ]);

    if (GLib.file_test(logoPath, GLib.FileTest.EXISTS)) {
      const gicon = Gio.Icon.new_for_string(logoPath);

      let icon = new St.Icon({
        gicon: gicon,
        icon_size: 16,
        style_class: "codexbar-tab-icon",
      });

      return icon;
    }
    return null;
  }

  /**
   * Helper to create a command box with a Copy button.
   * Crea un contenedor con el comando y un botón para copiar al portapapeles.
   */
  _createCommandWithCopyButton(commandText) {
    let box = new St.BoxLayout({
      vertical: false,
      x_expand: true,
      style:
        "background-color: rgba(0,0,0,0.3); padding: 4px 8px; border-radius: 4px; margin-top: 4px; spacing: 8px;",
    });

    let cmdLabel = new St.Label({
      text: commandText,
      style:
        "font-family: monospace; font-size: 0.8em; color: #3584e4; y-align: middle;",
      x_expand: true,
    });
    cmdLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    box.add_child(cmdLabel);

    let copyBtn = new St.Button({
      style:
        "padding: 2px 6px; background-color: rgba(255,255,255,0.1); border-radius: 3px; font-size: 0.8em; color: #ffffff;",
      label: _("Copy"),
    });
    copyBtn.connect("clicked", () => {
      const clipboard = St.Clipboard.get_default();
      clipboard.set_text(St.ClipboardType.CLIPBOARD, commandText);
      copyBtn.label = _("Copied!");
      let timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
        copyBtn.label = _("Copy");
        if (this._copyTimeouts) {
          const index = this._copyTimeouts.indexOf(timeoutId);
          if (index > -1) {
            this._copyTimeouts.splice(index, 1);
          }
        }
        return GLib.SOURCE_REMOVE;
      });
      if (this._copyTimeouts) {
        this._copyTimeouts.push(timeoutId);
      }
    });
    box.add_child(copyBtn);

    return box;
  }

  /**
   * Show welcome screen for first-run or missing dependencies.
   * Muestra la pantalla de bienvenida para la primera ejecución o dependencias faltantes.
   */
  _showWelcomeScreen(codexbarExists, importerExists) {
    let box = new St.BoxLayout({
      vertical: true,
      x_expand: true,
      style: "padding: 12px; spacing: 10px;",
    });

    box.add_child(
      new St.Label({
        text: _("Welcome to CodexBar!"),
        style: "font-weight: bold; font-size: 1.25em; margin-bottom: 5px;",
      }),
    );

    box.add_child(
      new St.Label({
        text: _("Please configure your system dependencies:"),
        style: "font-size: 0.95em; color: #a6e3a1; margin-bottom: 10px;",
      }),
    );

    // --- Dependency 1: CodexBar CLI ---
    // --- Dependencia 1: CodexBar CLI ---
    let dep1Box = new St.BoxLayout({
      vertical: true,
      style:
        "margin-bottom: 10px; background-color: rgba(255,255,255,0.05); padding: 8px; border-radius: 6px;",
    });
    let dep1Header = new St.BoxLayout({ vertical: false });

    let dep1StatusColor = codexbarExists ? "#2ec27e" : "#e01b24";
    let dep1StatusText = codexbarExists ? _("● Installed") : _("● Missing");

    dep1Header.add_child(
      new St.Label({
        text: _("1. CodexBar CLI  "),
        style: "font-weight: bold;",
      }),
    );
    dep1Header.add_child(
      new St.Label({
        text: dep1StatusText,
        style: `color: ${dep1StatusColor}; font-size: 0.85em; font-weight: bold;`,
      }),
    );
    dep1Box.add_child(dep1Header);

    dep1Box.add_child(
      new St.Label({
        text: _("Required to query AI usage metrics."),
        style:
          "font-size: 0.85em; color: #b5b5b5; margin-bottom: 4px; margin-top: 2px;",
      }),
    );

    if (!codexbarExists) {
      dep1Box.add_child(
        this._createCommandWithCopyButton("brew install steipete/tap/codexbar"),
      );
    }
    box.add_child(dep1Box);

    // --- Dependency 2: Cookie Importer for codex ---
    // --- Dependencia 2: Importador de Cookies para codex---
    let dep2Box = new St.BoxLayout({
      vertical: true,
      style:
        "margin-bottom: 10px; background-color: rgba(255,255,255,0.05); padding: 8px; border-radius: 6px;",
    });
    let dep2Header = new St.BoxLayout({ vertical: false });

    let dep2StatusColor = importerExists ? "#2ec27e" : "#ff7800";
    let dep2StatusText = importerExists
      ? _("● Installed")
      : _("● Optional (only for codex users and only if you want not to find and copy manually a cookie value)");

    dep2Header.add_child(
      new St.Label({
        text: _("2. Cookie Importer  "),
        style: "font-weight: bold;",
      }),
    );
    dep2Header.add_child(
      new St.Label({
        text: dep2StatusText,
        style: `color: ${dep2StatusColor}; font-size: 0.85em; font-weight: bold;`,
      }),
    );
    dep2Box.add_child(dep2Header);

    dep2Box.add_child(
      new St.Label({
        text: _("Enables browser auto cookie extraction for Codex (ChatGPT). This cookie is used to authenticate on the usage api of OpenAI"),
        style:
          "font-size: 0.85em; color: #b5b5b5; margin-bottom: 4px; margin-top: 2px;",
      }),
    );

    if (!importerExists) {
      dep2Box.add_child(
        this._createCommandWithCopyButton(
          "mkdir -p ~/.local/bin && curl -fsSL https://raw.githubusercontent.com/InledGroup/codexbar-gnome/main/scripts/codexbar-cookie-importer -o ~/.local/bin/codexbar-cookie-importer && chmod +x ~/.local/bin/codexbar-cookie-importer",
        ),
      );
    }
    box.add_child(dep2Box);

    // --- Dependency 3: SSL Helper (for Antigravity) ---
    // --- Dependencia 3: Asistente SSL (para Antigravity) ---
    let dep3Box = new St.BoxLayout({
      vertical: true,
      style:
        "margin-bottom: 10px; background-color: rgba(255,255,255,0.05); padding: 8px; border-radius: 6px;",
    });
    let dep3Header = new St.BoxLayout({ vertical: false });

    // Verify if the certificate is already installed/trusted
    const systemCaCertsPath = "/usr/local/share/ca-certificates/antigravity.crt";
    const certInstalled = GLib.file_test(systemCaCertsPath, GLib.FileTest.EXISTS);
    let dep3StatusColor = certInstalled ? "#2ec27e" : "#ff7800";
    let dep3StatusText = certInstalled
      ? _("● Installed")
      : _("● Optional (for Antigravity)");

    dep3Header.add_child(
      new St.Label({
        text: _("3. AGY Server Certificate Trust Helper  "),
        style: "font-weight: bold;",
      }),
    );
    dep3Header.add_child(
      new St.Label({
        text: dep3StatusText,
        style: `color: ${dep3StatusColor}; font-size: 0.85em; font-weight: bold;`,
      }),
    );
    dep3Box.add_child(dep3Header);

    dep3Box.add_child(
      new St.Label({
        text: _("Required to trust the local Antigravity server certificate. Requires privilegie elevation"),
        style:
          "font-size: 0.85em; color: #b5b5b5; margin-bottom: 4px; margin-top: 2px;",
      }),
    );

    if (!certInstalled) {
      dep3Box.add_child(
        this._createCommandWithCopyButton(
          "mkdir -p ~/.local/bin && curl -fsSL https://raw.githubusercontent.com/InledGroup/codexbar-gnome/main/scripts/codexbar-ssl-helper -o ~/.local/bin/codexbar-ssl-helper && chmod +x ~/.local/bin/codexbar-ssl-helper && codexbar-ssl-helper",
        ),
      );
    }
    box.add_child(dep3Box);



    // --- Buttons ---
    // --- Botones ---
    let btnBox = new St.BoxLayout({
      vertical: false,
      style: "margin-top: 10px;",
      x_align: Clutter.ActorAlign.CENTER,
    });

    // Tengo que actualizar la maldita documentación. La pasaré a una WIKI de GH.

   /* let docBtn = new St.Button({
      label: _("Documentation"),
      style_class: "codexbar-tab",
      style: "margin-right: 10px;",
    });
    docBtn.connect("clicked", () => {
      Gio.AppInfo.launch_default_for_uri(
        "https://help.inled.es/help/codexbar-gnome",
        null,
      );
    });
    btnBox.add_child(docBtn);
    */

    let closeBtn = new St.Button({
      label: _("Get Started!"),
      style_class: "codexbar-tab",
      style: "background-color: #3584e4;",
    });
    closeBtn.connect("clicked", () => {
      this._settings.set_boolean("first-run", false);
      this._refreshData();
    });
    btnBox.add_child(closeBtn);
    box.add_child(btnBox);

    this._contentBox.add_child(box);
  }
}
