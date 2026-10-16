import type { FileTree } from "@pierre/trees";
import { type CSSProperties, type ReactNode, useLayoutEffect, useRef, useState } from "react";

import { RESIZABLE_WIDTH_PROPERTY, useResizableWidth } from "~/hooks/useResizableWidth";
import { observeResize } from "~/lib/observeResize";

import { RightPanelResizeHandle } from "../preview/RightPanelResizeHandle";

/** Resizes the diff file list, fitting its expanded rows until the reader saves a width. */
export function DiffFileTreePanel({
  children,
  model,
  defaultWidth,
  minWidth,
}: {
  children: ReactNode;
  model: FileTree;
  defaultWidth: number;
  minWidth: number;
}) {
  const hostRef = useRef<HTMLElement>(null);
  const [maxWidth, setMaxWidth] = useState(640);
  const [contentWidth, setContentWidth] = useState(defaultWidth);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let frame = 0;
    const measure = () => {
      const tree = model.getFileTreeContainer();
      const row = tree?.shadowRoot?.querySelector<HTMLElement>("button[data-type='item']");
      const content = row?.querySelector<HTMLElement>("[data-item-section='content']");
      const canvas = document.createElement("canvas").getContext("2d");
      if (!tree || !row || !content || !canvas) return;
      const style = getComputedStyle(row);
      canvas.font = getComputedStyle(content).font;
      const gap = parseFloat(style.columnGap);
      const spacing = row.querySelector<HTMLElement>("[data-item-section='spacing']");
      const decoration = row.querySelector<HTMLElement>("[data-item-section='decoration']");
      // The empty decoration lane absorbs spare space; exclude it and this row's indentation.
      const chrome =
        tree.getBoundingClientRect().width -
        content.getBoundingClientRect().width -
        (decoration?.getBoundingClientRect().width ?? 0) -
        (spacing ? spacing.getBoundingClientRect().width + gap : 0);
      const icon = row.querySelector<HTMLElement>("[data-item-section='icon']");
      const indentStart = (icon?.getBoundingClientRect().width ?? 16) / 2 - 0.5 + gap;
      // Pierre's spacing columns are 8px at normal density.
      const indentStep = 8 * model.getDensityFactor();
      let preferred = defaultWidth;
      for (const item of model.getVisibleRows(0, model.getVisibleCount())) {
        const segments = item.flattenedSegments;
        const labelWidth = segments?.length
          ? segments.reduce((sum, segment) => sum + canvas.measureText(segment.name).width, 0) +
            (segments.length - 1) * (canvas.measureText("/").width + 4)
          : canvas.measureText(item.name).width;
        const indent = item.depth > 0 ? indentStart + item.depth * indentStep : 0;
        preferred = Math.max(preferred, Math.ceil(chrome + indent + labelWidth + 1));
      }
      setContentWidth(preferred);
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    schedule();
    const unsubscribe = model.subscribe(schedule);
    const unobserve = observeResize(host, schedule);
    document.fonts.addEventListener("loadingdone", schedule);
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
      unobserve();
      document.fonts.removeEventListener("loadingdone", schedule);
    };
  }, [defaultWidth, model]);

  useLayoutEffect(() => {
    const row = hostRef.current?.parentElement;
    if (!row) return;
    // Leave at least half the row for the diff, including in narrow preview panels.
    const measure = () => setMaxWidth(Math.max(0, Math.min(640, row.clientWidth / 2)));
    measure();
    return observeResize(row, measure);
  }, []);

  const { width, handlers } = useResizableWidth({
    storageKey: "t3code:diff-file-tree-width",
    defaultWidth: contentWidth,
    minWidth: Math.min(minWidth, maxWidth),
    maxWidth,
    edge: "left",
  });

  return (
    <aside
      ref={hostRef}
      className="relative flex w-(--resizable-width) min-w-0 shrink-0 border-l border-border/60"
      style={{ [RESIZABLE_WIDTH_PROPERTY]: `${width}px` } as CSSProperties}
    >
      <RightPanelResizeHandle handlers={handlers} className="touch-none" />
      {children}
    </aside>
  );
}
