// @effect-diagnostics nodeBuiltinImport:off -- Exercises the real git repository and swap script the fork updater runs.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";

vi.mock("electron", () => ({ app: { isPackaged: false } }));
vi.mock("electron-updater", () => ({ autoUpdater: {} }));
import { SWAP_APP_SCRIPT, hasUnbuiltForkChanges } from "./ForkUpdater.ts";

function makeRepo(): { readonly dir: string; readonly commit: (branch: string) => string } {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-updater-"));
  const git = (...args: ReadonlyArray<string>) =>
    NodeChildProcess.execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
  git("init", "--quiet", "--initial-branch=main");
  const commit = (branch: string) => {
    if (git("branch", "--list", branch) === "") git("switch", "--quiet", "--orphan", branch);
    else git("switch", "--quiet", branch);
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      branch,
    );
    return git("rev-parse", "--short=12", "HEAD");
  };
  commit("main");
  git("branch", "fork/feature");
  return { dir, commit };
}

it("reports fork branch commits that the running build does not contain", async () => {
  const repo = makeRepo();
  try {
    const built = repo.commit("fork/feature");
    await expect(hasUnbuiltForkChanges(repo.dir, built)).resolves.toBe(false);

    repo.commit("fork/feature");
    await expect(hasUnbuiltForkChanges(repo.dir, built)).resolves.toBe(true);

    const rebuilt = repo.commit("main");
    await expect(hasUnbuiltForkChanges(repo.dir, rebuilt)).resolves.toBe(true);

    await expect(hasUnbuiltForkChanges(repo.dir, "0123456789ab")).resolves.toBe(false);
  } finally {
    NodeFS.rmSync(repo.dir, { recursive: true, force: true });
  }
});

function makeSwapFixture() {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-swap-"));
  const bundle = (path: string, marker: string) => {
    NodeFS.mkdirSync(NodePath.join(path, "Contents"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(path, "Contents", "marker"), marker);
  };
  const next = NodePath.join(dir, "build", "New.app");
  const applications = NodePath.join(dir, "Applications");
  const current = NodePath.join(applications, "App.app");
  const opened = NodePath.join(dir, "opened");
  bundle(next, "new");
  NodeFS.mkdirSync(applications);
  // Stand-ins for the macOS tools; ditto reports a finished copy on fd 3 when the test listens.
  const bin = NodePath.join(dir, "bin");
  NodeFS.mkdirSync(bin);
  NodeFS.writeFileSync(
    NodePath.join(bin, "ditto"),
    '#!/bin/sh\ncp -R "$1" "$2" && { echo staged >&3; } 2>/dev/null\n',
    { mode: 0o755 },
  );
  NodeFS.writeFileSync(NodePath.join(bin, "open"), `#!/bin/sh\necho "$1" >>"${opened}"\n`, {
    mode: 0o755,
  });
  const swap = (appPid: number) =>
    NodeChildProcess.spawn(
      "/bin/sh",
      ["-c", SWAP_APP_SCRIPT, "swap", String(appPid), next, current],
      {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
        stdio: ["ignore", "ignore", "ignore", "pipe"],
      },
    );
  return {
    dir,
    current,
    bundle,
    swap,
    applicationsEntries: () => NodeFS.readdirSync(applications).toSorted(),
    marker: () => NodeFS.readFileSync(NodePath.join(current, "Contents", "marker"), "utf8"),
    opened: () => NodeFS.readFileSync(opened, "utf8").split("\n").filter(Boolean),
  };
}

const exitCode = (child: NodeChildProcess.ChildProcess) =>
  new Promise<number | null>((resolve) => child.once("exit", resolve));

it("lets one swap helper own a bundle while a second one leaves it alone", async () => {
  const fixture = makeSwapFixture();
  try {
    fixture.bundle(fixture.current, "old");
    const runningApp = NodeChildProcess.spawn("/bin/sh", ["-c", "read _"], {
      stdio: ["pipe", "ignore", "ignore"],
    });
    const owner = fixture.swap(runningApp.pid!);
    const ownerExit = exitCode(owner);
    await new Promise((resolve) => owner.stdio[3]!.once("data", resolve));

    await expect(exitCode(fixture.swap(runningApp.pid!))).resolves.toBe(1);
    runningApp.stdin!.end();

    await expect(ownerExit).resolves.toBe(0);
    expect(fixture.applicationsEntries()).toEqual(["App.app"]);
    expect(NodeFS.readdirSync(NodePath.join(fixture.current))).toEqual(["Contents"]);
    expect(fixture.marker()).toBe("new");
    expect(fixture.opened()).toEqual([fixture.current]);
  } finally {
    NodeFS.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

it("restores a backup an interrupted swap left behind before installing", async () => {
  const fixture = makeSwapFixture();
  try {
    fixture.bundle(`${fixture.current}.previous`, "old");
    const exitedApp = NodeChildProcess.spawn("/bin/sh", ["-c", "exit 0"]);
    await exitCode(exitedApp);

    await expect(exitCode(fixture.swap(exitedApp.pid!))).resolves.toBe(0);
    expect(fixture.applicationsEntries()).toEqual(["App.app"]);
    expect(fixture.marker()).toBe("new");
  } finally {
    NodeFS.rmSync(fixture.dir, { recursive: true, force: true });
  }
});
