import type { VcsStagingFile, VcsStagingStatusResult } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyStagingMoves, isStagingMoveActive, type StagingMove } from "./stagingMoves";

const file = (
  path: string,
  change: VcsStagingFile["change"],
  previousPath: string | null = null,
): VcsStagingFile => ({ path, previousPath, change }) as VcsStagingFile;

const status: VcsStagingStatusResult = {
  unstaged: [file("b.ts", "modified"), file("both.ts", "modified"), file("new.ts", "untracked")],
  staged: [file("a.ts", "modified"), file("both.ts", "modified"), file("c.ts", "added")],
  truncated: false,
};

const move = (
  from: StagingMove["from"],
  to: StagingMove["to"],
  files: VcsStagingFile[],
  settledAt: number | null = null,
): StagingMove => ({ id: 0, from, to, files, settledAt });

const summary = (result: VcsStagingStatusResult) => ({
  unstaged: result.unstaged.map((entry) => `${entry.path}:${entry.change}`),
  staged: result.staged.map((entry) => `${entry.path}:${entry.change}`),
});

describe("applyStagingMoves", () => {
  it("moves files between lists in git order, converting new-file kinds", () => {
    const result = applyStagingMoves(status, [
      move("unstaged", "staged", [file("new.ts", "untracked"), file("b.ts", "modified")]),
      move("staged", "unstaged", [file("c.ts", "added")]),
    ]);
    expect(summary(result)).toEqual({
      unstaged: ["both.ts:modified", "c.ts:untracked"],
      staged: ["a.ts:modified", "b.ts:modified", "both.ts:modified", "new.ts:added"],
    });
  });

  it("keeps the target's entry for a partly staged file, and discards drop files entirely", () => {
    const result = applyStagingMoves(status, [
      move("unstaged", "staged", [file("both.ts", "modified")]),
      move("unstaged", null, [file("b.ts", "modified")]),
    ]);
    expect(summary(result)).toEqual({
      unstaged: ["new.ts:untracked"],
      staged: ["a.ts:modified", "both.ts:modified", "c.ts:added"],
    });

    // Unstaging a rename whose new path also has unstaged edits keeps the old path for restaging.
    const renamed = applyStagingMoves(
      { ...status, staged: [file("both.ts", "renamed", "old.ts")] },
      [move("staged", "unstaged", [file("both.ts", "renamed", "old.ts")])],
    );
    expect(renamed.unstaged.find((entry) => entry.path === "both.ts")?.previousPath).toBe("old.ts");
  });

  it("applies moves in order, so a quick stage then unstage ends where it started", () => {
    const result = applyStagingMoves(status, [
      move("unstaged", "staged", [file("b.ts", "modified")]),
      move("staged", "unstaged", [file("b.ts", "modified")]),
    ]);
    expect(summary(result)).toEqual(summary(status));
  });
});

describe("isStagingMoveActive", () => {
  it("stays active until a status fetched after the move settled arrives", () => {
    expect(isStagingMoveActive(move("unstaged", "staged", [], null), 500)).toBe(true);
    expect(isStagingMoveActive(move("unstaged", "staged", [], 100), 99)).toBe(true);
    expect(isStagingMoveActive(move("unstaged", "staged", [], 100), 100)).toBe(false);
  });
});
