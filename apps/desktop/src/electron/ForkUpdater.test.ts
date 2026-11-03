// @effect-diagnostics nodeBuiltinImport:off -- Exercises the real git repository the fork updater reads.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";

vi.mock("electron", () => ({ app: { isPackaged: false } }));
vi.mock("electron-updater", () => ({ autoUpdater: {} }));
import { hasUnbuiltForkChanges } from "./ForkUpdater.ts";

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
