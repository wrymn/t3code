import type { FileTreeRowDecorationContext, GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree, useFileTreeSelector } from "@pierre/trees/react";
import { ChevronsDownUpIcon, ChevronsUpDownIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { PIERRE_TREE_UNSAFE_CSS, pierreTreeStyle } from "~/pierre-tree-theme";

import { areAllDirectoriesExpanded, setAllDirectoriesExpanded } from "../files/fileTreeExpansion";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  buildDiffFileTreeUpdates,
  compareDiffFileTreeEntries,
  collectDirectoryPaths,
  diffFileTreeModel,
  diffFileTreePositions,
  type DiffFileTreeEntry,
} from "./diffFileTree.logic";

export type { DiffFileTreeEntry } from "./diffFileTree.logic";

const NO_COMMENT_COUNTS: ReadonlyMap<string, number> = new Map();

interface DiffFileTreeProps {
  readonly entries: ReadonlyArray<DiffFileTreeEntry>;
  /** Comment totals keyed by entry path; files with a positive total show a comment bubble. */
  readonly commentCounts?: ReadonlyMap<string, number>;
  readonly onSelectFile: (path: string) => void;
  readonly selectedPath?: string | null;
  readonly revealRequestId?: number;
  /** File paths shown at reduced opacity, such as pull request files marked viewed. */
  readonly dimmedPaths?: ReadonlyArray<string>;
  readonly ariaLabel: string;
  readonly headerAccessory?: ReactNode;
  readonly footer?: ReactNode;
  readonly className?: string;
}

export function DiffFileTree({
  entries,
  commentCounts = NO_COMMENT_COUNTS,
  onSelectFile,
  selectedPath = null,
  revealRequestId = 0,
  dimmedPaths = [],
  ariaLabel,
  headerAccessory,
  footer,
  className,
}: DiffFileTreeProps) {
  const { resolvedTheme } = useTheme();
  const paths = entries.map((entry) => entry.path);
  const presented = diffFileTreeModel(paths);
  const modelPaths = presented.paths;
  const icons = presented.icons;
  const directoryPaths = collectDirectoryPaths(modelPaths);
  const positions = diffFileTreePositions(modelPaths);
  const [ordering] = useState(() => {
    let currentPositions: ReadonlyMap<string, number> = new Map();
    return {
      sort: compareDiffFileTreeEntries(() => currentPositions),
      update: (nextPositions: ReadonlyMap<string, number>) => {
        currentPositions = nextPositions;
      },
    };
  });
  const gitStatus: ReadonlyArray<GitStatusEntry> = entries.map((entry) => ({
    path: presented.modelPath(entry.path),
    status: entry.status,
  }));
  const dimmedRowsCSS =
    dimmedPaths.length === 0
      ? ""
      : `:is(${dimmedPaths
          .map(
            (path) =>
              `button[data-type='item'][data-item-path="${CSS.escape(presented.modelPath(path))}"]`,
          )
          .join(", ")}):not(:hover, [data-item-focused]) { opacity: 0.2; }`;
  const syncingSelectionRef = useRef(false);
  const handledRevealRef = useRef<{
    path: string;
    revealRequestId: number;
  } | null>(null);
  const mountedPresentationRef = useRef<ReturnType<typeof diffFileTreeModel> | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // The tree model keeps the first selection handler it was given.
  const handleSelectionChange = useStableCallback((selectedPaths: ReadonlyArray<string>) => {
    if (syncingSelectionRef.current) return;
    const modelPath = selectedPaths.at(-1);
    if (modelPath && modelPaths.includes(modelPath)) {
      onSelectFile(presented.selectionPath(modelPath));
    }
  });

  const renderRowDecoration = useStableCallback(({ item }: FileTreeRowDecorationContext) => {
    if (item.kind !== "file") return null;
    const count = commentCounts.get(presented.selectionPath(item.path)) ?? 0;
    if (count === 0) return null;
    return { icon: "t3-tree-icon-comment", title: count === 1 ? "1 comment" : `${count} comments` };
  });

  const { model } = useFileTree({
    density: "compact",
    flattenEmptyDirectories: true,
    initialExpansion: "open",
    icons,
    onSelectionChange: handleSelectionChange,
    paths: [],
    renderRowDecoration,
    search: false,
    sort: ordering.sort,
    unsafeCSS: PIERRE_TREE_UNSAFE_CSS,
  });
  const allDirectoriesExpanded = useFileTreeSelector(model, (currentModel) =>
    areAllDirectoriesExpanded(currentModel, directoryPaths),
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pushes the icon set into the imperative Pierre file tree model
  useEffect(() => {
    model.setIcons(icons);
  }, [icons, model]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Pierre fixes unsafeCSS at construction and has no per-row style hook, so dimmed rows are styled in its shadow root
  useEffect(() => {
    // The host attaches its shadow root on insertion, but the model only learns the host a commit later.
    const shadowRoot = rootRef.current?.querySelector("file-tree-container")?.shadowRoot;
    if (!shadowRoot || dimmedRowsCSS === "") return;
    const style = document.createElement("style");
    style.textContent = dimmedRowsCSS;
    shadowRoot.append(style);
    return () => style.remove();
  }, [dimmedRowsCSS]);
  const renderedCommentCountsRef = useRef(commentCounts);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- makes the Pierre tree model re-render row decorations when comment counts change
  useEffect(() => {
    if (renderedCommentCountsRef.current === commentCounts) return;
    renderedCommentCountsRef.current = commentCounts;
    model.setComposition(model.getComposition());
  }, [commentCounts, model]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- applies path updates, ordering and git status to the imperative Pierre file tree model
  useEffect(() => {
    ordering.update(positions);
    const mounted = mountedPresentationRef.current;
    if (mounted?.paths === modelPaths) return;
    mountedPresentationRef.current = presented;
    if (mounted === null) {
      model.resetPaths(modelPaths);
    } else if (mounted.paths.every((path, index) => modelPaths[index] === path)) {
      const updates = buildDiffFileTreeUpdates(mounted.paths, modelPaths);
      if (updates.length > 0) model.batch(updates);
    } else {
      // A reset can turn a file path into a directory. Carry selection and focus
      // through real paths so paging keeps the same file without revealing it again.
      const focusedPath = model.getFocusedPath();
      const nextFocusedPath =
        focusedPath === null ? null : presented.modelPath(mounted.selectionPath(focusedPath));
      const selectedPaths = model
        .getSelectedPaths()
        .map((path) => presented.modelPath(mounted.selectionPath(path)))
        .filter((path) => path.endsWith("/") || modelPaths.includes(path));
      const collapsedDirectories = directoryPaths.filter((path) => {
        const directory = model.getItem(path);
        return directory !== null && "isExpanded" in directory && !directory.isExpanded();
      });
      syncingSelectionRef.current = true;
      model.resetPaths(modelPaths);
      for (const path of model.getSelectedPaths()) model.getItem(path)?.deselect();
      for (const path of selectedPaths) model.getItem(path)?.select();
      queueMicrotask(() => {
        syncingSelectionRef.current = false;
      });
      for (const path of collapsedDirectories) {
        const directory = model.getItem(path);
        if (directory !== null && "collapse" in directory) directory.collapse();
      }
      if (
        nextFocusedPath !== null &&
        (modelPaths.includes(nextFocusedPath) || directoryPaths.includes(nextFocusedPath))
      ) {
        model.focusPath(nextFocusedPath);
      }
    }
    model.setGitStatus(gitStatus);
  }, [directoryPaths, gitStatus, model, modelPaths, ordering, positions, presented]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- expands ancestors, selects and scrolls to the requested file in the Pierre tree model
  useEffect(() => {
    if (selectedPath === null) {
      handledRevealRef.current = null;
      return;
    }
    const modelPath = presented.modelPath(selectedPath);
    const item = model.getItem(modelPath);
    if (item === null || item.isDirectory()) {
      handledRevealRef.current = null;
      return;
    }
    const handled = handledRevealRef.current;
    if (handled?.path === selectedPath && handled.revealRequestId === revealRequestId) {
      return;
    }
    handledRevealRef.current = { path: selectedPath, revealRequestId };
    syncingSelectionRef.current = true;
    for (const path of model.getSelectedPaths()) {
      if (path !== modelPath) model.getItem(path)?.deselect();
    }
    let ancestor = "";
    for (const segment of modelPath.split("/").slice(0, -1)) {
      ancestor += `${segment}/`;
      const directory = model.getItem(ancestor);
      if (directory !== null && "expand" in directory) directory.expand();
    }
    item.select();
    model.scrollToPath(modelPath, { offset: "nearest" });
    queueMicrotask(() => {
      syncingSelectionRef.current = false;
    });
  }, [model, presented, revealRequestId, selectedPath]);

  return (
    <div ref={rootRef} className={cn("flex min-h-0 flex-1 flex-col bg-background", className)}>
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 text-xs text-muted-foreground in-data-[preview-panel-mode=inline]:mb-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent"
        data-surface-subheader
      >
        <span className="px-1 font-medium text-foreground">Files</span>
        <span className="ml-auto tabular-nums">{entries.length}</span>
        {headerAccessory}
        {directoryPaths.length > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={
                    allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"
                  }
                  onClick={() =>
                    setAllDirectoriesExpanded(model, directoryPaths, !allDirectoriesExpanded)
                  }
                />
              }
            >
              {allDirectoriesExpanded ? (
                <ChevronsDownUpIcon className="size-3.5" />
              ) : (
                <ChevronsUpDownIcon className="size-3.5" />
              )}
            </TooltipTrigger>
            <TooltipPopup>
              {allDirectoriesExpanded ? "Collapse all folders" : "Expand all folders"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      <FileTree
        model={model}
        aria-label={ariaLabel}
        onClickCapture={(event) => {
          if (
            event.defaultPrevented ||
            event.button !== 0 ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey ||
            event.altKey
          ) {
            return;
          }
          // Pierre emits no change for its sole selected row; read before the click to avoid double reveals.
          const selected = model.getSelectedPaths();
          const path = selected.length === 1 ? selected[0] : undefined;
          if (!path || !modelPaths.includes(path)) return;
          const clickedSelectedRow = event.nativeEvent
            .composedPath()
            .some(
              (node) => node instanceof HTMLElement && node.getAttribute("data-item-path") === path,
            );
          if (clickedSelectedRow) onSelectFile(presented.selectionPath(path));
        }}
        className="min-h-0 flex-1 overflow-hidden"
        style={pierreTreeStyle(resolvedTheme)}
      />
      {footer}
    </div>
  );
}
