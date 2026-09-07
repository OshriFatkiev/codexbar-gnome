import Gio from "gi://Gio";

// Shell resource imports are unavailable outside GNOME Shell. Load the actual
// extension class with only its base class, translation and keyring stubbed;
// these tests exercise refresh/settings behavior without constructing UI actors.
const file = Gio.File.new_for_uri(import.meta.url).get_parent().get_child("extension.js");
const [, contents] = file.load_contents(null);
const source = new TextDecoder().decode(contents)
  .replace(/^import\s[\s\S]*?;\s*$/gm, "")
  .replace("export default class CodexBarExtension", "return class CodexBarExtension");

function equal(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const provider = (id, useApi = false) => ({ id, name: id, command: id, useApi });
const usage = (id) => ({ accountEmail: id, primary: { usedPercent: 25 } });

function fixture(providers, fetchCli, loadToken = async () => "test-cookie") {
  const Extension = new Function("Extension", "_", "loadToken", source)(
    class {}, (text) => text, loadToken,
  );
  const extension = new Extension();
  let configured = providers;
  const renders = [];
  const requests = [];
  extension._providers = providers;
  extension._providersData = [];
  extension._activeProviderIndex = 0;
  extension._headerTitle = { text: "CodexBar", set_text(text) { this.text = text; } };
  extension._cancellable = { is_cancelled: () => false };
  extension._settings = {
    get_boolean: () => false,
    get_string: () => JSON.stringify(configured),
  };
  extension._setupTimeout = () => {};
  let latestRefresh;
  const refresh = extension._refreshData.bind(extension);
  extension._refreshData = () => (latestRefresh = refresh());
  extension._updateUI = () => renders.push(extension._providers.map((p, i) => [
    p.id, extension._providersData[i]?.data?.usage?.accountEmail ?? null,
  ]));
  extension._apiClient = {
    async fetchCliSummary(command) {
      requests.push(command);
      await fetchCli(command);
      return { data: { usage: usage(command) }, command };
    },
    async fetchSummary(_token, id) {
      requests.push(id);
      return { usage: usage(id), labels: ["Session"] };
    },
    normalizeSummary: (value) => ({ usage: value }),
  };
  return {
    extension, requests, renders,
    configure(next) {
      configured = next;
      extension._onSettingsChanged();
      return latestRefresh;
    },
  };
}

const tests = [
  ["reordering during a CLI fetch never relabels another provider's data", async () => {
    const pending = deferred();
    const state = fixture([provider("a"), provider("b")], () => pending.promise);
    const run = state.extension._refreshData();
    state.configure([provider("b"), provider("a")]);
    pending.resolve();
    await run;
    equal(state.requests, ["a", "b", "a"], "Fetch the latest provider order after discarding the old run");
    equal(state.renders.at(-1), [["b", "b"], ["a", "a"]], "Results belong to their displayed providers");
    equal(state.extension._loading, false, "Refresh guard is released");
  }],
  ["a settings change clears old results and keeps the selected provider", async () => {
    const pending = deferred();
    const state = fixture([provider("a"), provider("b")], () => pending.promise);
    state.extension._providersData = ["a", "b"].map((id) => ({ data: { usage: usage(id) } }));
    const run = state.configure([provider("b"), provider("a")]);
    state.extension._updateUI();
    equal(state.renders.at(-1), [["b", null], ["a", null]], "No cached data under a different provider");
    equal(state.extension._activeProviderIndex, 1, "Keep provider a selected after reordering");
    pending.resolve();
    await run;
  }],
  ["reordering while the keyring is pending skips the outdated API request", async () => {
    const token = deferred();
    const state = fixture([provider("a", true), provider("b", true)], async () => {}, () => token.promise);
    const run = state.extension._refreshData();
    state.configure([provider("b", true), provider("a", true)]);
    token.resolve("test-cookie");
    await run;
    equal(state.requests, ["b", "a"], "Only query the current API configuration");
    equal(state.renders.at(-1), [["b", "b"], ["a", "a"]], "API results stay with their provider");
  }],
  ["removing all providers while a request fails leaves the display empty", async () => {
    const pending = deferred();
    const state = fixture([provider("a")], () => pending.promise);
    const run = state.extension._refreshData();
    state.configure([]);
    pending.reject(new Error("test failure"));
    await run;
    equal(state.extension._providersData, [], "Discard errors from a removed provider");
    equal(state.renders.at(-1), [], "Render the empty configuration immediately");
    equal(state.extension._loading, false, "Release the guard even with no providers left");
    equal(state.extension._headerTitle.text, "CodexBar", "No refreshing title after removing every provider");
  }],
  ["a pending API response cannot restore an outdated configuration", async () => {
    const pending = deferred();
    const started = deferred();
    const state = fixture([provider("a", true)], async () => {});
    state.extension._apiClient.fetchSummary = async (_token, id) => {
      state.requests.push(id);
      started.resolve();
      await pending.promise;
      return { usage: usage(id), labels: ["Session"] };
    };
    const run = state.extension._refreshData();
    await started.promise;
    state.configure([provider("b", true)]);
    pending.resolve();
    await run;
    equal(state.requests, ["a", "b"], "Fetch the latest configuration after the old API response");
    equal(state.renders.at(-1), [["b", "b"]], "Only publish the current API response");
  }],
  ["an old enable cycle cannot publish data or release a new refresh", async () => {
    const old = deferred();
    const current = deferred();
    const state = fixture([provider("a")], (id) => id === "a" ? old.promise : current.promise);
    const oldRun = state.extension._refreshData();
    // Simulate disable/enable replacing the cancellable and resetting the guard.
    state.extension._cancellable = { is_cancelled: () => false };
    state.extension._loading = false;
    const currentRun = state.configure([provider("b")]);
    old.resolve();
    await oldRun;
    equal(state.extension._loading, true, "Old callbacks cannot release the current guard");
    equal(state.extension._providersData, [], "Old callbacks cannot publish data");
    current.resolve();
    await currentRun;
    equal(state.renders.at(-1), [["b", "b"]], "The new enable cycle finishes normally");
    equal(state.extension._loading, false, "The new cycle releases its own guard");
  }],
];

let failures = 0;
for (const [name, test] of tests) {
  try {
    await test();
    console.log(`PASS: ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL: ${name}: ${error.message}`);
  }
}
if (failures) throw new Error(`${failures} refresh regression test(s) failed`);
