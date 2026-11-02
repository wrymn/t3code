import type { CSSProperties } from "react";

export const PIERRE_TREE_UNSAFE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-selected-bg-override: color-mix(in srgb, currentColor 12%, transparent);
    --trees-hover-bg-override: color-mix(in srgb, currentColor 7%, transparent);
    --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
    --trees-font-family-override: var(--font-sans);
    --trees-font-size-override: 0.75rem;
  }
  button[data-type='item'], button[data-type='item']::before { border-radius: var(--radius-md); }
  svg[data-icon-name='t3-tree-icon-loading'] { opacity: 0.6; }
  @media (prefers-reduced-motion: no-preference) {
    svg[data-icon-name='t3-tree-icon-loading'] { animation: t3-tree-spin 1s linear infinite; }
  }
  @keyframes t3-tree-spin { to { transform: rotate(360deg); } }
`;

/** Width of the fade that clips long diff tree labels. */
export const DIFF_TREE_LABEL_FADE_PX = 24;

/**
 * The diff file list sizes itself to its labels, so long names clip at the end behind a fade
 * instead of Pierre's middle truncation. The label takes the spare row space, so only names
 * that reach the edge meet the fade.
 */
export const DIFF_TREE_UNSAFE_CSS = `${PIERRE_TREE_UNSAFE_CSS}
  [data-item-section='content'] {
    flex-grow: 1;
    mask-image: linear-gradient(to right, #000 calc(100% - ${DIFF_TREE_LABEL_FADE_PX}px), transparent);
  }
  [data-item-section='content'] :is([data-truncate-group-container] > div, [data-truncate-container]) {
    flex-shrink: 0;
    min-width: max-content;
  }
  [data-item-section='content'] [data-truncate-marker-cell] { display: none; }
  [data-item-section='decoration'] { flex-grow: 0; }
`;

export function pierreTreeStyle(colorScheme: "light" | "dark"): CSSProperties {
  return {
    colorScheme,
    ["--trees-fg-override" as string]: "var(--contrast-foreground)",
  };
}
