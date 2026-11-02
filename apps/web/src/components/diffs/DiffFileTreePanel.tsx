import type { FileTree } from "@pierre/trees";
import {
  type CSSProperties,
  type ReactNode,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { RESIZABLE_WIDTH_PROPERTY, useResizableWidth } from "~/hooks/useResizableWidth";
import { observeResize } from "~/lib/observeResize";
import { DIFF_TREE_LABEL_FADE_PX } from "~/pierre-tree-theme";

import { RightPanelResizeHandle } from "../preview/RightPanelResizeHandle";
import { diffFileTreeRows } from "./diffFileTree.logic";

/** Resizes the diff file list, fitting every file's row until the reader saves a width. */
export function DiffFileTreePanel({
  children,
  model,
  paths,
  defaultWidth,
  minWidth,
}: {
  children: ReactNode;
  model: FileTree;
  paths: ReadonlyArray<string>;
  defaultWidth: number;
  minWidth: number;
}) {
  const hostRef = useRef<HTMLElement>(null);
  const [maxWidth, setMaxWidth] = useState(640);
  const [contentWidth, setContentWidth] = useState(defaultWidth);
  // Fit all files, not just expanded rows, so opening a folder never moves the panel edge.
  const rows = useMemo(() => diffFileTreeRows(paths), [paths]);

  const { width, saved, reset, handlers } = useResizableWidth({
    storageKey: "t3code:diff-file-tree-width",
    defaultWidth: contentWidth,
    minWidth: Math.min(minWidth, maxWidth),
    maxWidth,
    edge: "left",
  });

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || saved) return;
    let frame = 0;
    let measured = false;
    const canvas = document.createElement("canvas").getContext("2d");
    const measure = () => {
      const tree = model.getFileTreeContainer();
      const row = tree?.shadowRoot?.querySelector<HTMLElement>("button[data-type='item']");
      const content = row?.querySelector<HTMLElement>("[data-item-section='content']");
      // A hidden panel lays out at zero width and would yield meaningless row chrome.
      if (!tree || !row || !content || !canvas || tree.getBoundingClientRect().width === 0) return;
      measured = true;
      canvas.font = getComputedStyle(content).font;
      const gap = parseFloat(getComputedStyle(row).columnGap);
      const spacing = row.querySelector<HTMLElement>("[data-item-section='spacing']");
      // Everything but the label and this row's indentation; the label box also holds spare space.
      const chrome =
        tree.getBoundingClientRect().width -
        content.getBoundingClientRect().width -
        (spacing ? spacing.getBoundingClientRect().width + gap : 0);
      const icon = row.querySelector<HTMLElement>("[data-item-section='icon']");
      const indentStart = (icon?.getBoundingClientRect().width ?? 16) / 2 - 0.5 + gap;
      // Pierre's spacing columns are 8px at normal density.
      const indentStep = 8 * model.getDensityFactor();
      const separator = canvas.measureText("/").width + 4;
      let preferred = defaultWidth;
      for (const { depth, segments } of rows) {
        const labelWidth =
          segments.reduce((sum, segment) => sum + canvas.measureText(segment).width, 0) +
          (segments.length - 1) * separator;
        const indent = depth > 0 ? indentStart + depth * indentStep : 0;
        preferred = Math.max(
          preferred,
          Math.ceil(chrome + indent + labelWidth + DIFF_TREE_LABEL_FADE_PX),
        );
      }
      setContentWidth(preferred);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    // Rows and layout only need watching until the first real measurement.
    const scheduleUntilMeasured = () => {
      if (!measured) schedule();
    };
    schedule();
    const unsubscribe = model.subscribe(scheduleUntilMeasured);
    const unobserve = observeResize(host, scheduleUntilMeasured);
    document.fonts.addEventListener("loadingdone", schedule);
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
      unobserve();
      document.fonts.removeEventListener("loadingdone", schedule);
    };
  }, [defaultWidth, model, rows, saved]);

  useLayoutEffect(() => {
    const row = hostRef.current?.parentElement;
    if (!row) return;
    // Leave at least half the row for the diff, including in narrow preview panels.
    const measure = () => setMaxWidth(Math.max(0, Math.min(640, row.clientWidth / 2)));
    measure();
    return observeResize(row, measure);
  }, []);

  return (
    <aside
      ref={hostRef}
      className="relative flex w-(--resizable-width) min-w-0 shrink-0 border-l border-border/60"
      style={{ [RESIZABLE_WIDTH_PROPERTY]: `${width}px` } as CSSProperties}
    >
      <RightPanelResizeHandle handlers={handlers} onReset={reset} className="touch-none" />
      {children}
    </aside>
  );
}
