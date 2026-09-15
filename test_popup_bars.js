import Gio from "gi://Gio";

// Load the real bar builder; only the Shell actors and theme boundary are fake.
const [, contents] = Gio.File.new_for_uri(import.meta.url).get_parent()
  .get_child("extension.js").load_contents(null);
const source = new TextDecoder().decode(contents)
  .replace(/^import\s[\s\S]*?;\s*$/gm, "")
  .replace("export default class CodexBarExtension", "return class CodexBarExtension");

function equal(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

class Signals {
  constructor() { this.handlers = new Map(); this.nextId = 1; }
  connect(signal, callback) {
    const id = this.nextId++;
    this.handlers.set(id, { signal, callback });
    return id;
  }
  disconnect(id) { this.handlers.delete(id); }
  emit(signal) {
    for (const { signal: name, callback } of [...this.handlers.values()]) {
      if (name === signal) callback(this);
    }
  }
}

const activeProperty = "-barlevel-active-background-color";
const trackProperty = "-barlevel-background-color";
const color = (red, green, blue, alpha = 255) => ({ red, green, blue, alpha });
const accent = color(24, 160, 96, 153);
const track = color(200, 201, 202, 51);

function fixture() {
  const context = new Signals();
  const theme = {
    colors: { [activeProperty]: accent, [trackProperty]: track },
    available: true,
    reads: 0,
  };
  const stage = {};
  class Actor extends Signals {
    constructor(params = {}) {
      super();
      Object.assign(this, { visible: true, reactive: false, style: null }, params);
      this.children = [];
      this.pseudoClasses = new Set(this.reactive ? [] : ["insensitive"]);
      this.styleWrites = 0;
    }
    connect(signal, callback) {
      // Clutter exposes mapping as a property notification, not a "map" signal.
      if (!["notify::mapped", "style-changed", "destroy"].includes(signal)) {
        throw new Error(`Unsupported St.Widget signal: ${signal}`);
      }
      return super.connect(signal, callback);
    }
    add_child(child) { child.parent = this; this.children.push(child); }
    get_children() { return this.children; }
    get_stage() { return this.stage ?? this.parent?.get_stage() ?? null; }
    remove_style_pseudo_class(name) { this.pseudoClasses.delete(name); }
    get_style() { return this.style; }
    set_style(style) {
      if (this.destroyed) throw new Error("Styling a destroyed bar");
      this.styleWrites++;
      if (this.styleWrites > 20) throw new Error("Recursive style updates");
      this.style = style;
      this.emit("style-changed");
      for (const child of this.children) child.emit("style-changed");
    }
    ensure_style() { this.emit("style-changed"); }
    get_theme_node() {
      theme.reads++;
      if (!this.get_stage()) throw new Error("Theme lookup before stage attachment");
      if (this.destroyed) throw new Error("Reading a destroyed probe");
      if (!theme.available) throw new Error("Theme node unavailable");
      return {
        lookup_color: (property, inherit) => {
          equal(inherit, false, "Only use colors defined for the slider");
          const value = theme.colors[property];
          if (value instanceof Error) throw value;
          // A theme may dim disabled controls differently from its normal slider.
          if (this.pseudoClasses.has("insensitive")) return [true, color(100, 100, 100)];
          return [!!value, value];
        },
      };
    }
    map() {
      this.mapped = true;
      this.emit("notify::mapped");
    }
    destroy() {
      this.emit("destroy");
      for (const child of this.children) child.destroy();
      this.handlers.clear();
      this.destroyed = true;
    }
  }
  const St = { Widget: Actor, BoxLayout: Actor, ThemeContext: { get_for_stage: () => context } };
  const Extension = new Function("Extension", "St", "global", source)(class {}, St, { stage });
  const extension = new Extension();
  return {
    context, theme,
    build(percent = 40) {
      const container = extension._buildPopupProgressBar(percent);
      const fill = container.children.find((child) => child.style_class === "codexbar-progress-bar");
      return {
        container, fill,
        mount() { container.stage = stage; container.map(); },
      };
    },
  };
}

function background(actor) {
  const match = actor.get_style()?.match(/background-color:\s*rgba\(([^)]+)\)/);
  return match ? match[1].split(",").map(Number) : null;
}

function width(actor) {
  return Number(actor.get_style()?.match(/width:\s*(\d+)px/)?.[1]);
}

const tests = [
  ["all quota levels use the normal theme accent and preserve alpha and width", () => {
    const f = fixture();
    for (const [percent, expectedWidth] of [[0, 1], [5, 15], [20, 58], [45, 131], [80, 232], [100, 290]]) {
      const bar = f.build(percent);
      bar.mount();
      equal(background(bar.fill), [24, 160, 96, 0.6], `Accent at ${percent}%`);
      equal(background(bar.container), [200, 201, 202, 0.2], `Track at ${percent}%`);
      equal(width(bar.fill), expectedWidth, `Width at ${percent}%`);
      equal(bar.container.children.filter((child) => child.visible).length, 1,
        "The theme probe takes no visible space");
      bar.container.destroy();
    }
  }],
  ["missing theme properties independently restore stylesheet fallbacks", () => {
    const f = fixture();
    const bar = f.build();
    bar.mount();
    delete f.theme.colors[activeProperty];
    f.context.emit("changed");
    equal(background(bar.fill), null, "Missing accent clears its previous inline color");
    equal(background(bar.container), [200, 201, 202, 0.2], "Track still follows the theme");
    f.theme.colors[activeProperty] = accent;
    f.theme.colors[trackProperty] = new Error("Unsupported track property");
    f.context.emit("changed");
    equal(background(bar.fill), [24, 160, 96, 0.6], "Accent still follows the theme");
    equal(background(bar.container), null, "Unreadable track uses the stylesheet");
    equal(width(bar.fill), 116, "Fallback never removes the fill width");
    f.theme.available = false;
    f.context.emit("changed");
    equal(background(bar.fill), null, "An unavailable node restores the accent fallback too");
    bar.container.destroy();
  }],
  ["stage attachment and remapping retry unavailable theme colors", () => {
    const f = fixture();
    const bar = f.build();
    f.context.emit("changed");
    equal(f.theme.reads, 0, "No theme-node lookup before attachment");
    equal(background(bar.fill), null, "Unattached bar uses the stylesheet");
    f.theme.available = false;
    bar.mount();
    equal(background(bar.container), null, "Unavailable theme node is harmless");
    f.theme.available = true;
    bar.container.map();
    equal(background(bar.fill), [24, 160, 96, 0.6], "Opening retries the theme lookup");
    bar.container.mapped = false;
    f.theme.colors[activeProperty] = color(180, 50, 90);
    f.context.emit("changed");
    bar.container.map();
    equal(background(bar.fill), [180, 50, 90, 1], "Reopening uses the latest theme");
    bar.container.destroy();
  }],
  ["live theme changes do not recurse, repeat styling, or resize the fill", () => {
    const f = fixture();
    const bar = f.build();
    bar.mount();
    f.theme.colors = {
      [activeProperty]: color(120, 50, 200),
      [trackProperty]: color(20, 30, 40, 0),
    };
    f.context.emit("changed");
    equal(background(bar.fill), [120, 50, 200, 1], "Visible fill changes immediately");
    equal(background(bar.container), [20, 30, 40, 0], "Transparent is a valid track color");
    const writes = [bar.container.styleWrites, bar.fill.styleWrites];
    f.context.emit("changed");
    bar.container.map();
    equal([bar.container.styleWrites, bar.fill.styleWrites], writes, "Unchanged styles are not reassigned");
    equal(width(bar.fill), 116, "Theme changes preserve the quota width");
    bar.container.destroy();
  }],
  ["destroying or rebuilding bars releases theme callbacks", () => {
    const f = fixture();
    const first = f.build();
    const second = f.build();
    first.mount();
    second.mount();
    first.container.destroy();
    f.theme.colors[activeProperty] = color(220, 110, 10);
    f.context.emit("changed");
    equal(background(second.fill), [220, 110, 10, 1], "Other bars keep receiving changes");
    second.container.destroy();
    equal(f.context.handlers.size, 0, "Destroy disconnects every global theme callback");
    const reads = f.theme.reads;
    f.context.emit("changed");
    equal(f.theme.reads, reads, "Destroyed bars never read theme nodes");
    const rebuilt = f.build();
    rebuilt.mount();
    equal(background(rebuilt.fill), [220, 110, 10, 1], "A rebuilt popup reads the current theme");
    rebuilt.container.destroy();
  }],
];

for (const [name, test] of tests) {
  test();
  console.log(`PASS: ${name}`);
}
