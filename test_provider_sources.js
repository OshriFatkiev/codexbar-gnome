import { providerSourceSelection, buildCliCommand, parseGeneratedCommand } from "./providerSources.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// A fresh connection must never generate a source rejected by CodexBar's
// Gemini or Antigravity provider descriptor.
for (const [id, allowed] of [
  ["gemini", ["auto", "api"]],
  ["antigravity", ["auto", "cli", "oauth"]],
]) {
  const selection = providerSourceSelection({ id }, "auto");
  assert(selection.options.length === allowed.length, `${id}: missing supported choices`);
  for (const source of selection.options) {
    const parsed = parseGeneratedCommand(buildCliCommand(id, source));
    assert(allowed.includes(parsed.source), `${id}: offered unsupported ${source}`);
  }
}

// Opening preferences must not silently turn an existing invalid OAuth
// command into a dropdown claiming Auto. Keep it visible and flag it until
// the user explicitly chooses a supported source.
const saved = { id: "gemini", command: buildCliCommand("gemini", "oauth") };
const before = JSON.stringify(saved);
const old = providerSourceSelection(saved, parseGeneratedCommand(saved.command).source);
assert(old.source === "oauth", "saved OAuth selection was silently changed");
assert(old.unsupportedSource === "oauth", "invalid saved source was not flagged");
assert(old.options.includes(old.source), "saved source is absent from the dropdown");
assert(JSON.stringify(saved) === before, "opening preferences changed the saved command");
const changed = providerSourceSelection(saved, "api");
assert(!changed.options.includes("oauth"), "invalid source remained after correction");
assert(changed.unsupportedSource === null, "supported API selection was flagged");

// Source restrictions must not remove native cookie access or OAuth from
// unrelated providers, or change existing Antigravity OAuth connections.
const codex = providerSourceSelection({ id: "codex", supportsDirectApi: true }, "direct-api");
assert(codex.source === "direct-api" && codex.options.includes("oauth"), "Codex connection regression");
const anti = providerSourceSelection({ id: "antigravity" }, "oauth");
assert(anti.source === "oauth" && anti.unsupportedSource === null, "Antigravity OAuth regression");
print("Provider source compatibility tests passed");
