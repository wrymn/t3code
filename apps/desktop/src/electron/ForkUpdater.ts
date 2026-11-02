// @effect-diagnostics nodeBuiltinImport:off -- Runs inside electron-updater's promise API, and the swap process must outlive this app.
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { app } from "electron";
import { autoUpdater } from "electron-updater";

// Fork builds keep electron-updater for detecting upstream releases, but
// installing upstream's artifact would drop the fork's changes. Instead the
// update button merges the release into the fork and rebuilds it locally
// (scripts/fork-update.sh), then swaps the app bundle on quit.

const ForkPackageMetadata = Schema.fromJsonString(
  Schema.Struct({ t3codeForkSource: Schema.optional(Schema.String) }),
);
const decodeForkPackageMetadata = Schema.decodeUnknownOption(ForkPackageMetadata);

const SWAP_APP_SCRIPT = `
pid=$1 next=$2 current=$3
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
rm -rf "$current.previous"
if mv "$current" "$current.previous"; then
  if ditto "$next" "$current"; then rm -rf "$current.previous"
  else rm -rf "$current"; mv "$current.previous" "$current"; fi
fi
open "$current"
`;

export class ForkUpdateFailure extends Error {}

export interface ForkUpdater {
  readonly downloadUpdate: () => Promise<void>;
  readonly quitAndInstall: () => void;
}

function emitUpdaterEvent(eventName: string, payload: object): void {
  // electron-updater types its events with full release metadata that a local
  // build does not have; DesktopUpdates only reads `percent` and `version`.
  NodeEvents.EventEmitter.prototype.emit.call(autoUpdater, eventName, payload);
}

function readForkSource(): string | undefined {
  try {
    if (!app.isPackaged) return undefined;
    const text = NodeFS.readFileSync(NodePath.join(app.getAppPath(), "package.json"), "utf8");
    return Option.getOrUndefined(decodeForkPackageMetadata(text))?.t3codeForkSource;
  } catch {
    return undefined;
  }
}

function runForkBuild(forkSource: string, version: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // A login shell gives the build the user's PATH (node, vp, git), which a
    // Finder-launched app does not inherit.
    const child = NodeChildProcess.spawn(
      process.env.SHELL || "/bin/zsh",
      ["-lc", '"$0" build "$1"', NodePath.join(forkSource, "scripts", "fork-update.sh"), version],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let appPath: string | undefined;
    let errorMessage: string | undefined;
    NodeReadline.createInterface({ input: child.stdout }).on("line", (line) => {
      const separator = line.indexOf(" ");
      const tag = separator === -1 ? line : line.slice(0, separator);
      const value = separator === -1 ? "" : line.slice(separator + 1);
      if (tag === "@progress") emitUpdaterEvent("download-progress", { percent: Number(value) });
      else if (tag === "@app") appPath = value;
      else if (tag === "@error") errorMessage = value;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 && appPath) resolve(appPath);
      else reject(new ForkUpdateFailure(errorMessage ?? `Fork rebuild exited with code ${code}.`));
    });
  });
}

function currentAppBundle(): string | undefined {
  const marker = ".app/Contents/MacOS/";
  const index = process.execPath.indexOf(marker);
  return index === -1 ? undefined : process.execPath.slice(0, index + ".app".length);
}

export function fromPackagedApp(): ForkUpdater | undefined {
  const forkSource = readForkSource();
  if (forkSource === undefined) return undefined;

  let availableVersion: string | undefined;
  let builtApp: string | undefined;
  autoUpdater.on("update-available", (info) => {
    availableVersion = info.version;
  });

  return {
    downloadUpdate: async () => {
      const version = availableVersion;
      if (version === undefined) throw new ForkUpdateFailure("No upstream update to build.");
      builtApp = await runForkBuild(forkSource, version);
      emitUpdaterEvent("update-downloaded", { version });
    },
    quitAndInstall: () => {
      const bundle = currentAppBundle();
      if (builtApp === undefined || bundle === undefined) {
        throw new ForkUpdateFailure("No rebuilt app to install.");
      }
      NodeChildProcess.spawn(
        "/bin/sh",
        ["-c", SWAP_APP_SCRIPT, "swap", String(process.pid), builtApp, bundle],
        {
          detached: true,
          stdio: "ignore",
        },
      ).unref();
      app.quit();
    },
  };
}
