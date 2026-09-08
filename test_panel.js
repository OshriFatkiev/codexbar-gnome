import Gio from "gi://Gio";
import {
  deriveCreditsPercent,
  normalizeDetailSections,
  UsageApiClient,
} from "./usageApi.js";

// Exercise the actual panel selection logic without constructing Shell actors.
// Shell resource imports are unavailable in a standalone GJS process.
const file = Gio.File.new_for_uri(import.meta.url)
  .get_parent().get_child("extension.js");
const [, contents] = file.load_contents(null);
const source = new TextDecoder().decode(contents)
  .replace(/^import\s[\s\S]*?;\s*$/gm, "")
  .replace("export default class CodexBarExtension", "return class CodexBarExtension");
const Extension = new Function(
  "Extension", "_", "deriveCreditsPercent", "normalizeDetailSections", source,
)(
  class {}, (text) => text, deriveCreditsPercent, normalizeDetailSections,
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

const client = new UsageApiClient();
const credits = {
  title: "Credits",
  rows: [
    { label: "Total added", value: "$10.00" },
    { label: "Remaining", value: "$2.00" },
  ],
};
const keyBudget = {
  title: "API key",
  rows: [
    { label: "API key budget", value: "$5.00" },
    { label: "API key remaining", value: "$1.00" },
  ],
};

const budgetCases = [
  ["OpenRouter's placeholder uses its key budget", {
    primary: { usedPercent: 0 }, details: [keyBudget],
  }, "Credits", 80],
  ["credit details work without a placeholder tier", {
    details: [credits],
  }, "Credits", 80],
  ["the API key budget takes precedence over account credits", {
    details: [credits, { ...keyBudget, rows: [
      { label: "API key budget", value: "$5.00" },
      { label: "API key remaining", value: "$5.00" },
    ] }],
    providerCost: { used: 90, limit: 100 },
  }, "Credits", 0],
  ["providerCost supplies a budget percentage", {
    providerCost: { used: 20, limit: 100 },
  }, "Budget", 20],
  ["an exhausted cost budget is clamped to 100 percent", {
    providerCost: { used: 120, limit: 100 },
  }, "Budget", 100],
  ["an unused cost budget remains a valid zero percent", {
    providerCost: { used: 0, limit: 100 },
  }, "Budget", 0],
];

for (const [name, payload, label, used] of budgetCases) {
  const normalized = { data: client.normalizeSummary(payload) };
  for (const mode of ["used", "remaining"]) {
    for (const limit of [1, 2]) {
      equal(extension._panelWindows(normalized, mode, limit)
        .map((item) => [item.label, item.percent]),
      [[label, mode === "used" ? used : 100 - used]], `${name} (${mode}, limit ${limit})`);
    }
  }
  console.log(`PASS: ${name}`);
}

const timedAndBudget = data(session(30), weekly(40));
timedAndBudget.data.usage.details = [credits];
timedAndBudget.data.usage.providerCost = { used: 90, limit: 100 };
equal(extension._panelWindows(timedAndBudget, "used", 2)
  .map((item) => [item.label, item.percent]), [["5h", 30], ["7d", 40]],
  "Time windows retain precedence over financial details");

for (const invalid of [
  {},
  { primary: { usedPercent: 0 } },
  { details: [{ title: "Credits", rows: [{ label: "Remaining", value: "$5" }] }] },
  { providerCost: { used: 10, limit: 0 } },
  { providerCost: { used: 10, limit: -1 } },
  { providerCost: { limit: 100 } },
  { providerCost: { used: null, limit: 100 } },
  { providerCost: { used: NaN, limit: 100 } },
  { providerCost: { used: 10, limit: Infinity } },
]) {
  equal(extension._panelWindows({ data: { usage: invalid } }, "remaining", 1), [],
    "Missing or invalid budgets stay unavailable instead of inventing a percentage");
}
console.log("PASS: time-window precedence and unavailable-budget handling are preserved");

// A partial Antigravity response can still carry canonical quota windows.
// An empty list of additional windows must not erase those valid quotas.
const antigravityFallback = client.normalizeSummary({
  primary: { usedPercent: 25, windowMinutes: 300 },
  secondary: { usedPercent: 10, windowMinutes: 10080 },
  extraRateWindows: [],
}, true);
equal(extension._panelWindows({ data: antigravityFallback }, "remaining", 2)
  .map((item) => [item.label, item.percent]), [["5h", 75], ["7d", 90]],
  "Antigravity canonical quotas survive an empty extraRateWindows list");
console.log("PASS: Antigravity fallback quotas remain visible");
client.destroy();
