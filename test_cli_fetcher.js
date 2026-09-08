import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { UsageApiClient } from './usageApi.js';

function equal(actual, expected, message) {
    if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// Run the real subprocess adapter against a deterministic CLI. The first JSON
// fetch can be offline even though the next invocation returns live quotas.
const directory = GLib.dir_make_tmp('codexbar-fetch-test-XXXXXX');
const script = `${directory}/cli.sh`;
GLib.file_set_contents(script, `
count=$(cat "$1")
count=$((count + 1))
echo "$count" > "$1"
if [ "$count" -eq 1 ]; then
    cat "$2"
else
    cat "$3"
fi
`);
const offline = {
    provider: 'antigravity', source: 'offline', usage: {
        loginMethod: 'offline',
        extraRateWindows: [{title: 'Offline', usageKnown: false, window: {usedPercent: 0}}],
    },
};
const live = {
    provider: 'antigravity', source: 'cli', usage: {
        extraRateWindows: [{title: 'Gemini five-hour', window: {usedPercent: 25, windowMinutes: 300}}],
    },
};
const paths = [script];
let sequence = 0;
function command(first, second) {
    const prefix = `${directory}/${sequence++}`;
    const files = [`${prefix}.count`, `${prefix}.first`, `${prefix}.second`];
    GLib.file_set_contents(files[0], '0');
    GLib.file_set_contents(files[1], JSON.stringify([first]));
    GLib.file_set_contents(files[2], JSON.stringify([second]));
    paths.push(...files);
    return {
        text: ['/bin/sh', script, ...files].map((arg) => GLib.shell_quote(arg)).join(' ') + ' --format json',
        calls: () => Number(new TextDecoder().decode(GLib.file_get_contents(files[0])[1])),
    };
}

const client = new UsageApiClient();
const tests = [
    ['offline followed by live quotas recovers in the same refresh', async () => {
        const cli = command(offline, live);
        const result = await client.fetchCliSummary(cli.text);
        equal(result.data.source, 'cli', 'Return the recovered quota response');
        equal(cli.calls(), 2, 'Retry exactly once');
        equal(result.labels, ['Gemini five-hour'], 'Labels come from the recovered response');
    }],
    ['a healthy Antigravity refresh needs only one invocation', async () => {
        const cli = command(live, offline);
        const result = await client.fetchCliSummary(cli.text);
        equal(cli.calls(), 1, 'Do not launch agy again just for labels');
        equal(result.labels, ['Gemini five-hour'], 'Keep JSON labels');
    }],
    ['persistent offline data reports unavailability rather than unknown quota as usage', async () => {
        const cli = command(offline, offline);
        let error;
        try { await client.fetchCliSummary(cli.text); } catch (caught) { error = caught; }
        equal(error?.name, 'UsageApiError', 'Report a provider error');
        equal(error?.message.includes('live quotas'), true, 'Explain what is unavailable');
        equal(cli.calls(), 2, 'Stop after the bounded retry');
    }],
    ['cancellation during recovery does not launch another process', async () => {
        const cli = command(offline, live);
        const cancellable = new Gio.Cancellable();
        const timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => {
            if (cli.calls() === 0) return GLib.SOURCE_CONTINUE;
            cancellable.cancel();
            return GLib.SOURCE_REMOVE;
        });
        let error;
        try { await client.fetchCliSummary(cli.text, cancellable); } catch (caught) { error = caught; }
        if (!cancellable.is_cancelled()) GLib.source_remove(timer);
        equal(Boolean(error), true, 'Cancel the pending fetch');
        equal(cli.calls(), 1, 'Do not retry a cancelled refresh');
    }],
    ['structured providers use the same labels as the normalizer in one invocation', async () => {
        for (const provider of ['codex', 'claude', 'custom-provider']) {
            const payload = {provider, usage: {
                primary: {usedPercent: 25, windowMinutes: 300},
                secondary: {usedPercent: 10, windowMinutes: 10080},
            }};
            const cli = command(payload, {});
            const result = await client.fetchCliSummary(cli.text);
            equal(cli.calls(), 1, `${provider} does not need text discovery`);
            equal(result.labels, ['5-Hour Window', 'Weekly Window'], 'Preserve displayed labels');
            equal(result.data, payload, 'Keep the raw response intact');
        }
    }],
    ['additional named windows retain their label and tier order', async () => {
        const cli = command({provider: 'codex', usage: {
            primary: {usedPercent: 25, windowMinutes: 300},
            secondary: {usedPercent: 10, windowMinutes: 10080},
            extraRateWindows: [{title: 'Codex Spark', window: {usedPercent: 5, windowMinutes: 300}}],
        }}, {});
        const result = await client.fetchCliSummary(cli.text);
        equal(cli.calls(), 1, 'Named additional windows need no text discovery');
        equal(result.labels, ['5-Hour Window', 'Weekly Window', 'Codex Spark'], 'Keep the additional label in order');
    }],
    ['flat structured custom responses also avoid text discovery', async () => {
        const cli = command({primary: {usedPercent: 25, windowMinutes: 300}}, {});
        const result = await client.fetchCliSummary(cli.text);
        equal(cli.calls(), 1, 'No dependency on a provider name or usage wrapper');
        equal(result.labels, ['5-Hour Window'], 'Use the existing normalized label');
    }],
    ['legacy responses without normalized labels retain text discovery', async () => {
        const cli = command({usage: {used: 25, limit: 100, windowSeconds: 18000}}, {});
        GLib.file_set_contents(paths.at(-1), 'Session: 25% used\nWeekly: 10% used\n');
        const result = await client.fetchCliSummary(cli.text);
        equal(result.labels, ['Session', 'Weekly'], 'Preserve existing provider labels');
        equal(cli.calls(), 2, 'Keep the legacy discovery path');
    }],
];

let failures = 0;
try {
    for (const [name, run] of tests) {
        try { await run(); print(`PASS: ${name}`); }
        catch (error) { failures++; printerr(`FAIL: ${name}: ${error.message}`); }
    }
} finally {
    client.destroy();
    for (const path of paths) Gio.File.new_for_path(path).delete(null);
    Gio.File.new_for_path(directory).delete(null);
}
if (failures) throw new Error(`${failures} CLI fetch tests failed`);
