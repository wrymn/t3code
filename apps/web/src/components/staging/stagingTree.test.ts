import type { VcsStagingFile } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  stagingDirectoryKeysUnder,
  stagingFilesForKeys,
  stagingRows,
  stagingSuccessorKey,
  stagingToggleKey,
} from "./stagingTree";

const file = (path: string): VcsStagingFile =>
  ({ path, previousPath: null, change: "modified" }) as VcsStagingFile;

const files = [
  file("src/a/deep/one.ts"),
  file("src/a/deep/two.ts"),
  file("src/b.ts"),
  file("README.md"),
  file("srcfile.ts"),
];

describe("stagingRows", () => {
  it("puts folders first and folds single-child folder chains", () => {
    const rows = stagingRows(files, "tree", new Set());
    expect(
      rows.map((row) => `${row.depth}:${row.kind === "directory" ? row.key : row.name}`),
    ).toEqual([
      "0:src/",
      "1:src/a/deep/",
      "2:one.ts",
      "2:two.ts",
      "1:b.ts",
      "0:README.md",
      "0:srcfile.ts",
    ]);
    const src = rows[0];
    expect(src?.kind === "directory" && src.files.length).toBe(3);
  });

  it("hides the children of collapsed folders", () => {
    const rows = stagingRows(files, "tree", new Set(["src/a/deep/"]));
    expect(rows.map((row) => row.key)).toEqual([
      "src/",
      "src/a/deep/",
      "src/b.ts",
      "README.md",
      "srcfile.ts",
    ]);
  });
});

describe("stagingDirectoryKeysUnder", () => {
  it("includes nested folders even while collapsed, and not sibling prefixes", () => {
    expect(stagingDirectoryKeysUnder(files, "src/")).toEqual(["src/", "src/a/deep/"]);
  });
});

describe("stagingFilesForKeys", () => {
  it("expands a folder key to every file below it", () => {
    expect(stagingFilesForKeys(files, new Set(["src/", "README.md"])).map((f) => f.path)).toEqual([
      "src/a/deep/one.ts",
      "src/a/deep/two.ts",
      "src/b.ts",
      "README.md",
    ]);
  });
});

describe("stagingSuccessorKey", () => {
  it("selects the folder a survivor folds into after a move", () => {
    const listed = [
      file("src/b/x.ts"),
      file("src/c/a.ts"),
      file("src/c/d/z.ts"),
      file("README.md"),
    ];
    const moved = new Set(["src/b/x.ts", "src/c/a.ts"]);
    const before = stagingRows(listed, "tree", new Set());
    const after = stagingRows(
      listed.filter((entry) => !moved.has(entry.path)),
      "tree",
      new Set(),
    );
    expect(stagingSuccessorKey(before, after, moved)).toBe("src/c/d/");
  });
});

describe("stagingToggleKey", () => {
  it("removes a row selected through its folder and keeps the folder's other rows", () => {
    const rows = stagingRows(files, "tree", new Set());
    expect([...stagingToggleKey(rows, new Set(["src/"]), "src/a/deep/one.ts")]).toEqual([
      "src/a/deep/two.ts",
      "src/b.ts",
    ]);
  });
});
