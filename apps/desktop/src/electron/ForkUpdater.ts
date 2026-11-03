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

// Upstream's artifact would drop the fork's changes, so the update button
// rebuilds the fork locally (scripts/fork-update.sh) and swaps the bundle on
// quit. Fork branch commits this build lacks also count as an update, built
// at the current upstream version.

const ForkPackageMetadata = Schema.fromJsonString(
  Schema.Struct({
    t3codeForkSource: Schema.optional(Schema.String),
    t3codeCommitHash: Schema.optional(Schema.String),
  }),
);
const decodeForkPackageMetadata = Schema.decodeUnknownOption(ForkPackageMetadata);

// Stages the new bundle beside the current one so the swap itself is two
// renames, and reopens whichever app ends up in place. The log sits next to
// the built app in the release worktree.
const SWAP_APP_SCRIPT = `
pid=$1 next=$2 current=$3
exec >>"$(dirname "$next")/install.log" 2>&1
staged="$current.next" previous="$current.previous"
rm -rf "$staged" "$previous"
ditto "$next" "$staged" && staged_ok=1 || echo "staging $next failed"
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
if [ -n "\${staged_ok:-}" ] && mv "$current" "$previous"; then
  if mv "$staged" "$current"; then
    if open "$current"; then rm -rf "$previous"; exit 0; fi
    echo "opening the new app failed, restoring the previous one"
    rm -rf "$current"
  fi
  mv "$previous" "$current"
fi
rm -rf "$staged"
open "$current"
`;

export class ForkUpdateFailure extends Error {}

export interface ForkUpdater {
  readonly checkForUpdates: () => Promise<void>;
  readonly downloadUpdate: () => Promise<void>;
  readonly quitAndInstall: () => void;
}

function emitUpdaterEvent(eventName: string, payload: object): void {
  // electron-updater types its events with full release metadata that a local
  // build does not have; DesktopUpdates only reads `percent` and `version`.
  NodeEvents.EventEmitter.prototype.emit.call(autoUpdater, eventName, payload);
}

function readForkMetadata() {
  try {
    if (!app.isPackaged) return undefined;
    const text = NodeFS.readFileSync(NodePath.join(app.getAppPath(), "package.json"), "utf8");
    return Option.getOrUndefined(decodeForkPackageMetadata(text));
  } catch {
    return undefined;
  }
}

/**
 * Whether `main` or any `fork/*` branch in the fork checkout has commits that
 * `builtCommit` (the commit this app was built from) does not contain. An
 * unknown commit or a git failure counts as no changes, so a broken checkout
 * never offers a rebuild on every check.
 */
export function hasUnbuiltForkChanges(forkSource: string, builtCommit: string): Promise<boolean> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      "git",
      ["rev-list", "-n", "1", "refs/heads/main", "--branches=fork/*", "--not", builtCommit, "--"],
      { cwd: forkSource },
      (error, stdout) => resolve(error === null && stdout.trim() !== ""),
    );
  });
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
  const metadata = readForkMetadata();
  const forkSource = metadata?.t3codeForkSource;
  if (forkSource === undefined) return undefined;
  const builtCommit = metadata?.t3codeCommitHash;

  let availableVersion: string | undefined;
  let builtApp: string | undefined;
  autoUpdater.on("update-available", (info) => {
    availableVersion = info.version;
  });

  return {
    checkForUpdates: async () => {
      const result = await autoUpdater.checkForUpdates();
      if (result?.isUpdateAvailable || builtCommit === undefined) return;
      if (await hasUnbuiltForkChanges(forkSource, builtCommit)) {
        emitUpdaterEvent("update-available", { version: app.getVersion() });
      }
    },
    downloadUpdate: async () => {
      const version = availableVersion;
      if (version === undefined) throw new ForkUpdateFailure("No upstream update to build.");
      builtApp = await runForkBuild(forkSource, version);
      emitUpdaterEvent("update-downloaded", { version });
    },
    quitAndInstall: () => {
      const bundle = currentAppBundle();
      if (builtApp === undefined || bundle === undefined || !NodeFS.existsSync(builtApp)) {
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
