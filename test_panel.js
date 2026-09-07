import Gio from "gi://Gio";

// Exercise the actual panel selection logic without constructing Shell actors.
// Shell resource imports are unavailable in a standalone GJS process.
const file = Gio.File.new_for_uri(import.meta.url)
  .get_parent().get_child("extension.js");
const [, contents] = file.load_contents(null);
const source = new TextDecoder().decode(contents)
  .replace(/^import\s[\s\S]*?;\s*$/gm, "")
  .replace("export default class CodexBarExtension", "return class CodexBarExtension");
const Extension = new Function("Extension", "_", source)(
  class {}, (text) => text,
);
const extension = new Extension();

function equal(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const window = (usedPercent, windowSeconds) => ({ usedPercent, windowSeconds });
const data = (primary, secondary) => ({ data: { usage: { primary, secondary } } });
const session = (used) => window(used, 5 * 3600);
const weekly = (used) => window(used, 7 * 24 * 3600);

const cases = [
  ["an exhausted session wins over a nearly exhausted week", session(100), weekly(95), "5h", 100],
  ["the shorter window wins when both are exhausted", session(100), weekly(100), "5h", 100],
  ["an exhausted week wins over a healthy session", session(20), weekly(100), "7d", 100],
  ["a nearly exhausted week still escalates", session(20), weekly(95), "7d", 95],
  ["below the escalation threshold the session stays selected", session(20), weekly(94), "5h", 20],
  ["duration decides the shorter window regardless of tier order", weekly(95), session(100), "5h", 100],
];

for (const [name, primary, secondary, label, used] of cases) {
  for (const mode of ["used", "remaining"]) {
    const result = extension._panelWindows(data(primary, secondary), mode, 1);
    equal(result.map((item) => [item.label, item.percent]),
      [[label, mode === "used" ? used : 100 - used]], `${name} (${mode})`);
  }
  console.log(`PASS: ${name}`);
}

equal(extension._panelWindows(data(session(100), weekly(95)), "remaining", 2)
  .map((item) => [item.label, item.percent]), [["5h", 0], ["7d", 5]],
  "Expanded mode keeps both windows visible");
equal(extension._panelWindows(data(session(100), null), "remaining", 1)
  .map((item) => [item.label, item.percent]), [["5h", 0]],
  "A single exhausted window stays visible");
console.log("PASS: expanded and single-window displays are preserved");
