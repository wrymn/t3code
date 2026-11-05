import type { VcsStagingFile } from "@t3tools/contracts";

export type StagingView = "list" | "tree";

export type StagingRow =
  | {
      readonly kind: "directory";
      /** The directory path with a trailing slash, so it never collides with a file path. */
      readonly key: string;
      readonly name: string;
      readonly depth: number;
      readonly expanded: boolean;
      /** Every file below this directory, at any depth. */
      readonly files: ReadonlyArray<VcsStagingFile>;
    }
  | {
      readonly kind: "file";
      readonly key: string;
      readonly name: string;
      readonly depth: number;
      readonly file: VcsStagingFile;
    };

interface DirectoryNode {
  readonly directories: Map<string, DirectoryNode>;
  readonly files: VcsStagingFile[];
  readonly allFiles: VcsStagingFile[];
}

function fileName(path: string) {
  return path.slice(path.lastIndexOf("/") + 1);
}

function emptyNode(): DirectoryNode {
  return { directories: new Map(), files: [], allFiles: [] };
}

const byName = (left: string, right: string) => left.localeCompare(right);

/**
 * The visible rows for one list. The tree puts folders before files and folds
 * single-child folder chains into one row, as Fork and VS Code do.
 */
export function stagingRows(
  files: ReadonlyArray<VcsStagingFile>,
  view: StagingView,
  collapsed: ReadonlySet<string>,
): ReadonlyArray<StagingRow> {
  if (view === "list") {
    return files.map((file) => ({
      kind: "file",
      key: file.path,
      depth: 0,
      file,
      name: fileName(file.path),
    }));
  }

  const root = emptyNode();
  for (const file of files) {
    let node = root;
    for (const segment of file.path.split("/").slice(0, -1)) {
      let child = node.directories.get(segment);
      if (!child) {
        child = emptyNode();
        node.directories.set(segment, child);
      }
      child.allFiles.push(file);
      node = child;
    }
    node.files.push(file);
  }

  const rows: StagingRow[] = [];
  const visit = (node: DirectoryNode, prefix: string, depth: number) => {
    for (const [segment, start] of [...node.directories].toSorted(([a], [b]) => byName(a, b))) {
      let name = segment;
      let child = start;
      while (child.files.length === 0 && child.directories.size === 1) {
        const [nextSegment, next] = child.directories.entries().next().value!;
        name += `/${nextSegment}`;
        child = next;
      }
      const key = `${prefix}${name}/`;
      const expanded = !collapsed.has(key);
      rows.push({ kind: "directory", key, name, depth, expanded, files: child.allFiles });
      if (expanded) visit(child, key, depth + 1);
    }
    for (const file of node.files.toSorted((a, b) => byName(a.path, b.path))) {
      rows.push({
        kind: "file",
        key: file.path,
        depth,
        file,
        name: fileName(file.path),
      });
    }
  };
  visit(root, "", 0);
  return rows;
}

/** The directory itself plus every directory below it, expanded or not. */
export function stagingDirectoryKeysUnder(
  files: ReadonlyArray<VcsStagingFile>,
  key: string,
): ReadonlyArray<string> {
  return stagingRows(files, "tree", new Set())
    .filter((row) => row.kind === "directory" && row.key.startsWith(key))
    .map((row) => row.key);
}

/** Files named by row keys: a file key picks that file, a directory key every file below it. */
export function stagingFilesForKeys(
  files: ReadonlyArray<VcsStagingFile>,
  keys: ReadonlySet<string>,
): ReadonlyArray<VcsStagingFile> {
  const directories = [...keys].filter((key) => key.endsWith("/"));
  return files.filter(
    (file) => keys.has(file.path) || directories.some((key) => file.path.startsWith(key)),
  );
}

/**
 * The row to select after `moved` leave the list: the next survivor below the first moved row,
 * else the nearest one above. `after` is rebuilt because folding can rename surviving folders.
 */
export function stagingSuccessorKey(
  before: ReadonlyArray<StagingRow>,
  after: ReadonlyArray<StagingRow>,
  moved: ReadonlySet<string>,
): string | null {
  const surviving = new Set(after.map((row) => row.key));
  const start = Math.max(
    before.findIndex((row) =>
      row.kind === "file" ? moved.has(row.file.path) : row.files.every((f) => moved.has(f.path)),
    ),
    0,
  );
  const candidates = [...before.slice(start), ...before.slice(0, start).toReversed()];
  return candidates.find((row) => surviving.has(row.key))?.key ?? after[0]?.key ?? null;
}

/** Cmd/Ctrl-click: a row selected through a folder leaves while the folder's other rows stay. */
export function stagingToggleKey(
  rows: ReadonlyArray<StagingRow>,
  keys: ReadonlySet<string>,
  key: string,
): ReadonlySet<string> {
  const next = new Set(keys);
  if (next.delete(key)) return next;
  const owners = [...keys].filter((selected) => selected.endsWith("/") && key.startsWith(selected));
  if (owners.length === 0) return next.add(key);
  for (const owner of owners) next.delete(owner);
  const outer = owners.reduce((a, b) => (a.length <= b.length ? a : b));
  for (const row of rows) {
    const inside = row.key !== outer && row.key.startsWith(outer);
    const clickedOrBelow = row.key === key || (key.endsWith("/") && row.key.startsWith(key));
    const listsChildren = row.kind === "directory" && row.expanded;
    if (inside && !clickedOrBelow && !listsChildren) next.add(row.key);
  }
  return next;
}
