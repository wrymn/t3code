import { FileTree } from "@pierre/trees";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { DiffFileTree, type DiffFileTreeEntry } from "./DiffFileTree";

const FOLDERS = 300;

function row(container: HTMLElement, path: string) {
  return container
    .querySelector("file-tree-container")
    ?.shadowRoot?.querySelector(`button[data-type='item'][data-item-path="${path}"]`);
}

function rowOpacity(container: HTMLElement, path: string): string | undefined {
  const element = row(container, path);
  return element ? getComputedStyle(element).opacity : undefined;
}

it("dims viewed files and badges commented files that are known when the tree mounts", async () => {
  await using screen = await render(
    <DiffFileTree
      entries={[
        { path: "src/a.ts", status: "modified" },
        { path: "src/b.ts", status: "modified" },
      ]}
      dimmedPaths={["src/b.ts"]}
      commentCounts={new Map([["src/a.ts", 1]])}
      onSelectFile={() => {}}
      ariaLabel="Files"
    />,
  );

  await vi.waitFor(() => {
    expect(rowOpacity(screen.container, "src/a.ts")).toBe("1");
    expect(rowOpacity(screen.container, "src/b.ts")).toBe("0.2");
    expect(row(screen.container, "src/a.ts")?.querySelector('[title="1 comment"]')).not.toBeNull();
    expect(row(screen.container, "src/b.ts")?.querySelector('[title*="comment"]')).toBeNull();
  });
});

it("expands every folder without asking the tree about all folders for each one", async () => {
  // Two levels, so flattening empty folders cannot merge them into one.
  const entries: DiffFileTreeEntry[] = Array.from({ length: FOLDERS }, (_, index) => [
    { path: `package-${index}/a.ts`, status: "modified" as const },
    { path: `package-${index}/lib/b.ts`, status: "modified" as const },
  ]).flat();
  using getItem = vi.spyOn(FileTree.prototype, "getItem");
  await using _screen = await render(
    <div className="flex h-[600px] flex-col">
      <DiffFileTree entries={entries} onSelectFile={() => {}} ariaLabel="Changed files" />
    </div>,
  );
  const collapseAll = page.getByRole("button", { name: "Collapse all folders" });
  await expect.element(collapseAll).toBeVisible();
  await userEvent.click(collapseAll);
  const expandAll = page.getByRole("button", { name: "Expand all folders" });
  await expect.element(expandAll).toBeVisible();
  getItem.mockClear();
  await userEvent.click(expandAll);
  await expect.element(page.getByRole("button", { name: "Collapse all folders" })).toBeVisible();
  // Each of the expansions used to look up the folders again from the first one, so the lookups
  // grew with the square of the folder count (hundreds of thousands at 600 folders).
  expect(getItem.mock.calls.length).toBeLessThan(FOLDERS * 2 * 20);
});
