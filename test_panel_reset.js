import Gio from "gi://Gio";
import { UsageApiClient, deriveCreditsPercent, normalizeDetailSections } from "./usageApi.js";
import { OllamaSettingsFetcher } from "./adapters/OllamaSettingsFetcher.js";

// Run the real panel methods with only Shell actors and the timer scheduler replaced.
const [, contents] = Gio.File.new_for_uri(import.meta.url).get_parent()
  .get_child("extension.js").load_contents(null);
const source = new TextDecoder().decode(contents)
  .replace(/^import\s[\s\S]*?;\s*$/gm, "")
  .replace("export default class CodexBarExtension", "return class CodexBarExtension");
let nextId = 1;
const timers = new Map();
const scheduler = {
  PRIORITY_DEFAULT: 0,
  SOURCE_REMOVE: false,
  timeout_add_seconds(priority, seconds, callback) {
    equal(seconds, 60, "Reset labels refresh once a minute");
    const id = nextId++;
    timers.set(id, callback);
    return id;
  },
  source_remove(id) { timers.delete(id); },
};
const Extension = new Function(
  "Extension", "_", "deriveCreditsPercent", "normalizeDetailSections", "GLib", "nullTokenSchema", source,
)(class {}, (text) => text, deriveCreditsPercent, normalizeDetailSections, scheduler, () => {});
const extension = new Extension();
let clockFormat = "24h";
extension._clockSettings = { get_string: () => clockFormat };
let resetDisplay = "absolute";
const settings = {
  get_string: (key) => key === "panel-reset-display" ? resetDisplay : "remaining",
  get_boolean: () => false,
  disconnectObject() {},
};
extension._settings = settings;

function equal(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const now = new Date(2026, 8, 8, 12, 0).getTime();
const today = new Date(2026, 8, 8, 14, 30).getTime();
const friday = new Date(2026, 8, 11, 14, 30).getTime();
const client = new UsageApiClient();
const normalized = (window, time = now) =>
  client.normalizeSummary({ primary: { usedPercent: 100, windowSeconds: 18000, ...window } }, false, time)
    .usage.primary;

equal(normalized({ resetsAt: new Date(today).toISOString(), resetAfterSeconds: 60 }).resetAtMs,
  today, "Absolute reset timestamps take precedence");
equal(normalized({ resetAfterSeconds: 3600 }).resetAtMs, now + 3600000,
  "Relative resets become absolute at normalization");
equal(normalized({ resetsAt: "invalid", reset_after_seconds: "60" }).resetAtMs, now + 60000,
  "Invalid absolute dates can fall back to valid relative seconds");
for (const reset of [0, -1, "bad", Infinity]) {
  equal(normalized({ resetAfterSeconds: reset }).resetAtMs, undefined,
    `Invalid or nonpositive relative reset ${reset} stays unknown`);
}
equal(normalized({ resetsAt: "invalid" }).resetAtMs, undefined,
  "An invalid absolute date without a relative reset stays unknown");
const stable = normalized({ resetAfterSeconds: 60 });
equal(normalized(stable, now + 120000).resetAtMs, stable.resetAtMs,
  "Re-normalizing does not move an expired deadline forward");
equal(normalized({ resetsAt: new Date(now - 1000).toISOString(), resetAfterSeconds: 60 }).resetAtMs,
  now - 1000, "Past absolute resets are preserved rather than replaced by relative data");
for (const values of [{ used_percent: 100 }, { remainingPercent: 0 }, { used: 10, limit: 10 }]) {
  const window = { ...values, windowSeconds: 18000, reset_after_seconds: 60 };
  for (const [payload, antigravity] of [
    [{ primary: window }, false],
    [{ rate_limit: { primary_window: window } }, false],
    [{ arbitrary: { nested: window } }, false],
    [{ extraRateWindows: [{ title: "Model", window }] }, true],
  ]) {
    equal(client.normalizeSummary(payload, antigravity, now).usage.primary.resetAtMs, now + 60000,
      "Every quota normalization path preserves the deadline");
  }
}
const ollama = new OllamaSettingsFetcher();
const beforeParse = Date.now();
const ollamaSummary = ollama._parseSettingsHtml(
  '<h2>Cloud Usage</h2><div>Session usage 100% resets in 2 hours</div><div>Weekly usage 10%</div>');
const afterParse = Date.now();
const ollamaReset = ollamaSummary.usage.primary.resetAtMs;
equal(ollamaReset >= beforeParse + 7200000 && ollamaReset <= afterParse + 7200000, true,
  "Direct Ollama quotas also preserve reset timestamps");
client.destroy();
console.log("PASS: stable reset timestamps across provider normalization paths");

const window = (usedPercent, windowSeconds, resetAtMs) => ({ usedPercent, windowSeconds, resetAtMs });
const data = (primary, secondary) => ({ data: { usage: { primary, secondary } } });
const exhausted = data(window(100, 18000, today), window(100, 604800, friday));
for (const mode of ["remaining", "used"]) {
  const compact = extension._panelWindows(exhausted, mode, 1, now);
  equal(compact[0].resetAtMs, friday, "Compact mode shows the later exhausted reset");
  equal(compact[0].percent, mode === "remaining" ? 0 : 100, "Progress remains the real percentage");
  const expanded = extension._panelWindows(exhausted, mode, 2, now);
  equal(expanded.map((w) => extension._panelMetricText(w, now, "en-US")),
    ["◷ 14:30", "◷ Fri 14:30"], "Expanded mode shows each window's own reset");
  for (const missing of [undefined, NaN, Infinity, now - 1000]) {
    const unknown = extension._panelWindows(
      data(window(100, 18000, today), window(100, 604800, missing)), mode, 1, now);
    equal(extension._panelMetricText(unknown[0], now, "en-US"),
      `7d ${mode === "remaining" ? 0 : 100}%`, "Unknown blocking reset keeps the percentage");
  }
  const rounded = extension._panelWindows(data(window(99.6, 18000, today)), mode, 1, now)[0];
  equal(extension._panelMetricText(rounded, now, "en-US"),
    `5h ${mode === "remaining" ? 0 : 100}%`, "Rounding never implies actual exhaustion");
}
const metric = { label: "5h", used: 100, percent: 0, resetAtMs: today };
equal(extension._panelMetricText(metric, today, "en-US"), "5h 0%", "Elapsed resets revert to percentage");
equal(extension._panelMetricText({ ...metric, resetAtMs: new Date(2026, 8, 14, 14, 30).getTime() }, now, "en-US"),
  "◷ Mon 14:30", "The sixth future calendar day uses a weekday");
equal(extension._panelMetricText({ ...metric, resetAtMs: new Date(2026, 8, 15, 14, 30).getTime() }, now, "en-US"),
  "◷ Sep 15 14:30", "More distant resets include a month and date");
clockFormat = "12h";
equal(extension._panelMetricText(metric, now, "en-US"), "◷ 2:30 PM", "Desktop 12-hour preference is honored");
clockFormat = "24h";
const midnight = new Date(2026, 8, 9, 0, 0).getTime();
const tomorrow = { ...metric, resetAtMs: midnight + 1800000 };
equal(extension._panelMetricText(tomorrow, midnight - 60000, "en-US"), "◷ Wed 00:30",
  "Tomorrow is based on the local calendar");
equal(extension._panelMetricText(tomorrow, midnight, "en-US"), "◷ 00:30",
  "The weekday disappears at local midnight");
equal(extension._panelMetricText({ ...metric, resetAtMs: new Date(2026, 10, 1, 14, 30).getTime() },
  new Date(2026, 9, 26, 14, 30).getTime(), "en-US"), "◷ Sun 14:30",
  "Six calendar days still use a weekday across the autumn DST change");
equal(extension._panelMetricText({ ...metric, resetAtMs: new Date(2027, 0, 1, 0, 30).getTime() },
  new Date(2026, 11, 31, 23, 30).getTime(), "en-US"), "◷ Fri 00:30",
  "Tomorrow's weekday also works across a year boundary");
console.log("PASS: exhaustion, blocking resets, clock format, and calendar boundaries");

resetDisplay = "remaining";
for (const [seconds, expected] of [
  [1, "1m"], [59, "1m"], [60, "1m"], [61, "2m"],
  [2700, "45m"], [3540, "59m"], [3541, "1h"], [3600, "1h"],
  [3601, "1h1m"], [8100, "2h15m"], [86340, "23h59m"],
  [86341, "1d"], [86400, "1d"], [86460, "1d"],
  [90000, "1d1h"], [172800, "2d"], [184500, "2d3h"],
]) {
  equal(extension._panelMetricText({ ...metric, resetAtMs: now + seconds * 1000 }, now),
    `◷ ${expected}`, `Countdown rounds and formats ${seconds} seconds`);
}
clockFormat = "12h";
equal(extension._panelMetricText(metric, now), "◷ 2h30m", "Countdown ignores desktop clock format");
clockFormat = "24h";
for (const mode of ["remaining", "used"]) {
  for (const limit of [1, 2]) {
    const windows = extension._panelWindows(exhausted, mode, limit, now);
    equal(windows.map((w) => extension._panelMetricText(w, now)),
      limit === 1 ? ["◷ 3d2h"] : ["◷ 2h30m", "◷ 3d2h"],
      "Countdown preserves compact and expanded exhausted window selection");
    const mixed = extension._panelWindows(
      data(window(50, 18000, today), window(100, 604800, friday)), mode, limit, now);
    equal(mixed.map((w) => extension._panelMetricText(w, now)),
      limit === 1 ? ["◷ 3d2h"] : ["5h 50%", "◷ 3d2h"],
      "Only the exhausted window switches to a countdown");
  }
}
for (const resetAtMs of [undefined, NaN, Infinity, now, now - 1]) {
  equal(extension._panelMetricText({ ...metric, resetAtMs }, now), "5h 0%",
    "Countdown falls back to percentage for unknown or elapsed deadlines");
}
equal(extension._panelMetricText({ ...metric, used: 99.6 }, now), "5h 0%",
  "Countdown requires real exhaustion, not rounded exhaustion");
resetDisplay = "absolute";
equal(extension._panelMetricText(metric, now, "en-US"), "◷ 14:30",
  "Switching back restores the clock time");
console.log("PASS: countdown formatting, boundaries, and window selection");

// Drive the real update/render path and timer callback without fetching or Shell actors.
const realDateNow = Date.now;
let renderNow = now;
Date.now = () => renderNow;
const actor = () => ({ visible: false, destroy() {} });
const label = () => ({ text: "", get_text() { return this.text; }, set_text(text) { this.text = text; } });
extension._providers = [{ name: "Example" }];
extension._activeProviderIndex = 0;
extension._providersData = [data(window(100, 18000, Date.now() + 3600000))];
const renderedMetric = { box: actor(), label: label() };
extension._panelGroups = [{ box: actor(), logoId: null, logoBin: actor(), metrics: [renderedMetric] }];
extension._ensurePanelGroups = () => {};
extension._syncTrackWidths = () => {};
extension._applyMetricFill = (m) => equal(m.percent, 0, "Exhausted remaining progress stays empty");
extension._refreshData = () => { throw new Error("Label redraw must never fetch usage"); };
extension._updatePanel("remaining");
equal(renderedMetric.label.text.startsWith("◷ "), true, "The actual actor receives the reset label");
equal(timers.size, 1, "Visible reset labels start one timer");
extension._updatePanel("remaining");
equal(timers.size, 1, "Repeated rendering does not duplicate timers");
resetDisplay = "remaining";
extension._updatePanel("remaining");
equal(renderedMetric.label.text, "◷ 1h", "Changing the preference redraws cached quota immediately");
const [countdownTimerId, countdownCallback] = [...timers.entries()][0];
timers.delete(countdownTimerId);
renderNow += 60000;
countdownCallback();
equal(renderedMetric.label.text, "◷ 59m", "The local minute timer advances the countdown");
equal(timers.size, 1, "Countdown ticking maintains exactly one timer");
resetDisplay = "absolute";
extension._updatePanel("remaining");
equal(renderedMetric.label.text, extension._panelMetricText({ ...metric, resetAtMs: now + 3600000 }, renderNow),
  "Switching back to clock time updates the existing actor");
resetDisplay = "remaining";
const [timerId, callback] = [...timers.entries()][0];
timers.delete(timerId);
extension._providersData[0].data.usage.primary.resetAtMs = Date.now() - 1000;
equal(callback(), scheduler.SOURCE_REMOVE, "The minute callback is a one-shot local redraw");
equal(renderedMetric.label.text, "5h 0%", "The timer removes an expired reset label");
equal(timers.size, 0, "No timer remains when no reset labels are visible");
extension._providersData[0].data.usage.primary.resetAtMs = Date.now() + 3600000;
extension._updatePanel("remaining");
extension._providersData = [];
extension._updatePanel("remaining");
equal(timers.size, 0, "Unavailable data also removes the reset timer");
extension._providersData = [data(window(100, 18000, Date.now() + 3600000))];
extension._updatePanel("remaining");
let disconnected = false;
extension._clockSettings.disconnectObject = () => { disconnected = true; };
extension.disable();
equal(timers.size, 0, "Disable removes the reset timer");
equal(disconnected, true, "Disable disconnects desktop clock settings");
Date.now = realDateNow;
console.log("PASS: panel rendering and timer lifecycle without provider calls");
