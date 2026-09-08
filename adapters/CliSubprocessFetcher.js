import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { UsageFetcher } from '../core/ports/UsageFetcher.js';
import { UsageApiError } from '../usageApi.js';

/**
 * ADAPTER (Hexagonal Architecture)
 * Implementation of the UsageFetcher port to run the external 'codexbar' CLI
 * binary as a subprocess. It resolves the executable path dynamically, invokes
 * the tool, and parses stdout/stderr into structured JS objects. It also runs a
 * quick discovery pass to read the text labels for the provider's active windows.
 */
export class CliSubprocessFetcher extends UsageFetcher {
    constructor(extensionPath = null, labelResolver = null) {
        super();
        this._extensionPath = extensionPath;
        this._labelResolver = labelResolver;
    }

    /**
     * Run the command, parse the output, and discover labels.
     */
    async fetch(providerCommand, cancellable = null) {
        return this._fetch(providerCommand, cancellable, true);
    }

    async _fetch(providerCommand, cancellable, allowRetry) {
        cancellable?.set_error_if_cancelled();
        if (!providerCommand) {
            throw new UsageApiError("No command configured / No hay ningún comando configurado.");
        }

        // Step 1: Resolve the absolute path of the 'codexbar' executable.
        let executable = "/home/linuxbrew/.linuxbrew/bin/codexbar";
        const commonPaths = [
            "/home/linuxbrew/.linuxbrew/bin/codexbar",
            `${GLib.get_home_dir()}/.local/bin/codexbar`,
            "/usr/local/bin/codexbar",
            "/usr/bin/codexbar",
        ];

        for (const path of commonPaths) {
            if (GLib.file_test(path, GLib.FileTest.EXISTS)) {
                executable = path;
                break;
            }
        }

        let finalCommand = providerCommand;
        if (providerCommand.startsWith("codexbar") && !providerCommand.startsWith("/")) {
            finalCommand = providerCommand.replace("codexbar", executable);
        }

        // Setup launcher and custom environment (e.g. to propagate correct PATH)
        const env = GLib.get_environ();

        // Fix PATH to ensure codexbar can find the `agy` executable
        let currentPath = "";
        for (const item of env) {
            if (item.startsWith("PATH=")) {
                currentPath = item.substring(5);
                break;
            }
        }
        const userPaths = [
            `${GLib.get_home_dir()}/.local/bin`,
            "/home/linuxbrew/.linuxbrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin"
        ];
        const newPathDirs = [];
        for (const p of userPaths) {
            if (!newPathDirs.includes(p)) {
                newPathDirs.push(p);
            }
        }
        if (currentPath) {
            for (const p of currentPath.split(":")) {
                if (!newPathDirs.includes(p)) {
                    newPathDirs.push(p);
                }
            }
        }
        const newPath = newPathDirs.join(":");
        let pathFound = false;
        for (let i = 0; i < env.length; i++) {
            if (env[i].startsWith("PATH=")) {
                env[i] = `PATH=${newPath}`;
                pathFound = true;
                break;
            }
        }
        if (!pathFound) {
            env.push(`PATH=${newPath}`);
        }

        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
        });
        launcher.set_environ(env);

        // Step 2: Parse command line arguments directly to avoid unsafe shell execution
        const [ok, argv] = GLib.shell_parse_argv(finalCommand);
        if (!ok || !argv || argv.length === 0) {
            throw new UsageApiError("Invalid command line configuration / Configuración de línea de comandos no válida.");
        }

        const proc = launcher.spawnv(argv);

        const [stdout, stderr] = await new Promise((resolve, reject) => {
            proc.communicate_utf8_async(null, cancellable, (p, res) => {
                try {
                    const [ok, out, err] = p.communicate_utf8_finish(res);
                    resolve([out || "", err || ""]);
                } catch (e) {
                    if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                        resolve(["", ""]);
                    } else {
                        reject(e);
                    }
                }
            });
        });

        const trimmedStdout = stdout.trim();
        const trimmedStderr = stderr.trim();
        cancellable?.set_error_if_cancelled();

        const rawData = this._parseOutput(trimmedStdout, trimmedStderr);
        if (rawData?.provider === 'antigravity') {
            // Offline snapshots contain local history, not live quota. A fresh
            // agy session can recover on the next invocation without a login.
            if (rawData.source === 'offline' || rawData.usage?.loginMethod === 'offline') {
                if (allowRetry) {
                    await new Promise((resolve) => {
                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                            resolve();
                            return GLib.SOURCE_REMOVE;
                        });
                    });
                    return this._fetch(providerCommand, cancellable, false);
                }
                throw new UsageApiError(
                    'Antigravity live quotas are unavailable after retrying. ' +
                    'CodexBar returned offline history, not quota data. ' +
                    'If agy is already signed in, its quota service may still be unavailable.'
                );
            }

            const windows = rawData.usage?.extraRateWindows;
            if (Array.isArray(windows) && windows.length > 0) {
                // These labels describe this exact snapshot. A text discovery
                // call would start another agy session and discard its quotas.
                return {
                    data: rawData,
                    labels: windows.map((window) => window.title || 'Usage Window'),
                    command: finalCommand
                };
            }
        }

        // The client can derive the labels that the UI will use from this
        // snapshot. Only discover text labels when JSON cannot supply them.
        let labels = this._labelResolver?.(rawData) || [];
        if (labels.length > 0) {
            return { data: rawData, labels, command: finalCommand };
        }

        // Step 3: Legacy label discovery (run command in text mode to parse names)
        try {
            const discoveryArgv = argv.filter((arg, index) => {
                if (arg === "--format") return false;
                if (index > 0 && argv[index - 1] === "--format") return false;
                if (arg.startsWith("--format=")) return false;
                if (arg === "--json-only" || arg === "--json" || arg === "--json-output" || arg === "--pretty") return false;
                return true;
            });

            const dLauncher = new Gio.SubprocessLauncher({
                flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            });
            dLauncher.set_environ(env);
            const dProc = dLauncher.spawnv(discoveryArgv);

            const [dStdout] = await new Promise((resolve) => {
                dProc.communicate_utf8_async(null, cancellable, (p, res) => {
                    try {
                        const [ok, out] = p.communicate_utf8_finish(res);
                        resolve([out || ""]);
                    } catch (e) {
                        resolve([""]);
                    }
                });
            });

            if (dStdout) {
                const lines = dStdout.split("\n");
                for (let line of lines) {
                    const match = line.match(/^([^:]+):\s+\d+%/);
                    if (match) {
                        labels.push(match[1].trim());
                    }
                }
            }
        } catch (e) {
            // Ignore label discovery failures
        }

        return { data: rawData, labels, command: finalCommand };
    }

    _parseOutput(trimmedStdout, trimmedStderr) {
        if (trimmedStdout && (trimmedStdout.startsWith("[") || trimmedStdout.startsWith("{"))) {
            try {
                const parsed = JSON.parse(trimmedStdout);
                return Array.isArray(parsed) ? parsed[0] : parsed;
            } catch (e) {
                throw new UsageApiError(`JSON Error / Error JSON: ${e.message}`);
            }
        } else if (trimmedStderr) {
            throw new UsageApiError(`CLI Error / Error de CLI: ${trimmedStderr.split("\n")[0]}`);
        } else if (trimmedStdout) {
            throw new UsageApiError("Output is not valid JSON / La salida no es un JSON válido");
        } else {
            throw new UsageApiError("No output from command / Sin respuesta del comando");
        }
    }
}
