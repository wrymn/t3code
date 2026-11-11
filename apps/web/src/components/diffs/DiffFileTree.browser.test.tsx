import { expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";
import { DiffFileTree } from "./DiffFileTree";

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
