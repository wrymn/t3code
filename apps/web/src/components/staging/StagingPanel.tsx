import { useAtomMount, useAtomValue } from "@effect/atom-react";
import { parseDiffFromFile } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ReviewDiffFileContentsInput,
  VcsStagingFile,
} from "@t3tools/contracts";
import { useState, type DragEvent, type KeyboardEvent, type MouseEvent } from "react";

import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { useRenderedAppearance } from "~/hooks/useTheme";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import { cn, randomUUID } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { useGitStackedAction } from "~/state/sourceControlActions";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsEnvironment, vcsStatusRevalidation } from "~/state/vcs";

type StagingListKind = "unstaged" | "staged";

interface StagingSelection {
  readonly list: StagingListKind;
  readonly paths: ReadonlySet<string>;
  readonly anchor: string;
}

const CHANGE_LABELS: Record<VcsStagingFile["change"], { letter: string; className: string }> = {
  added: { letter: "A", className: "text-success-foreground" },
  untracked: { letter: "?", className: "text-success-foreground" },
  modified: { letter: "M", className: "text-warning-foreground" },
  "type-changed": { letter: "T", className: "text-warning-foreground" },
  deleted: { letter: "D", className: "text-destructive-foreground" },
  renamed: { letter: "R", className: "text-info-foreground" },
  copied: { letter: "C", className: "text-info-foreground" },
  conflicted: { letter: "U", className: "text-destructive-foreground" },
};

const DRAG_MIME = "application/x-t3-staging";

function changeTypeOf(file: VcsStagingFile): ReviewDiffFileContentsInput["changeType"] {
  switch (file.change) {
    case "added":
    case "untracked":
    case "copied":
      return "new";
    case "deleted":
      return "deleted";
    case "renamed":
      return "rename-changed";
    default:
      return "change";
  }
}

/** A rename moves two index entries, so both paths go to the server. */
function pathsFor(files: ReadonlyArray<VcsStagingFile>): string[] {
  return [
    ...new Set(
      files.flatMap((file) => (file.previousPath ? [file.previousPath, file.path] : [file.path])),
    ),
  ];
}

function splitPath(path: string) {
  const slash = path.lastIndexOf("/");
  return slash === -1
    ? { name: path, directory: "" }
    : { name: path.slice(slash + 1), directory: path.slice(0, slash) };
}

export function StagingPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
  readonly visible: boolean;
}) {
  const { environmentId, cwd } = props;
  const theme = useRenderedAppearance();
  const [selection, setSelection] = useState<StagingSelection | null>(null);
  const [dropTarget, setDropTarget] = useState<StagingListKind | null>(null);

  // Brings in edits and `git add` runs made outside T3 Code when the window regains focus.
  useAtomMount(vcsStatusRevalidation(cwd === null ? null : { environmentId, cwd }));
  const stagingQuery = useEnvironmentQuery(
    cwd === null || !props.visible
      ? null
      : vcsEnvironment.stagingStatus({ environmentId, input: { cwd } }),
  );
  const staging = stagingQuery.data;
  const lists: Record<StagingListKind, ReadonlyArray<VcsStagingFile>> = {
    unstaged: staging?.unstaged ?? [],
    staged: staging?.staged ?? [],
  };

  const canStage = useAtomValue(vcsEnvironment.stagePaths.permissionAtom(environmentId));
  const stagePaths = useAtomCommand(vcsEnvironment.stagePaths);
  const unstagePaths = useAtomCommand(vcsEnvironment.unstagePaths);
  const [moving, setMoving] = useState(false);
  const commitAction = useGitStackedAction({ environmentId, cwd });

  const selectedFiles = (list: StagingListKind) =>
    selection?.list === list ? lists[list].filter((file) => selection.paths.has(file.path)) : [];
  const focused =
    selection === null
      ? null
      : (() => {
          const file = lists[selection.list].find((entry) => entry.path === selection.anchor);
          return file ? { list: selection.list, file } : null;
        })();

  const move = async (from: StagingListKind, files: ReadonlyArray<VcsStagingFile>) => {
    if (cwd === null || files.length === 0 || moving || !canStage) return;
    setMoving(true);
    const movedPaths = new Set(files.map((file) => file.path));
    const remaining = lists[from].filter((file) => !movedPaths.has(file.path));
    const firstMovedIndex = lists[from].findIndex((file) => movedPaths.has(file.path));
    const next = remaining[Math.min(firstMovedIndex, remaining.length - 1)];
    const command = from === "unstaged" ? stagePaths : unstagePaths;
    const result = await command({ environmentId, input: { cwd, paths: pathsFor(files) } });
    setMoving(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: from === "unstaged" ? "Stage failed" : "Unstage failed",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
      return;
    }
    setSelection(next ? { list: from, anchor: next.path, paths: new Set([next.path]) } : null);
    if (next) document.getElementById(rowId(from, next.path))?.focus();
  };

  const commit = async () => {
    const result = await commitAction.run({
      actionId: randomUUID(),
      action: "commit",
      stagedOnly: true,
    });
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Commit failed",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
      return;
    }
    setSelection(null);
    toastManager.add({
      type: "success",
      title: result.value.toast.title,
      ...(result.value.toast.description ? { description: result.value.toast.description } : {}),
    });
  };

  const select = (list: StagingListKind, path: string, event: MouseEvent | KeyboardEvent) => {
    const extend = event.metaKey || event.ctrlKey;
    if (selection?.list === list && event.shiftKey) {
      const paths = lists[list].map((file) => file.path);
      const from = paths.indexOf(selection.anchor);
      const to = paths.indexOf(path);
      const [start, end] = from < to ? [from, to] : [to, from];
      setSelection({ list, anchor: path, paths: new Set(paths.slice(start, end + 1)) });
      return;
    }
    if (selection?.list === list && extend) {
      const paths = new Set(selection.paths);
      if (paths.has(path)) paths.delete(path);
      else paths.add(path);
      setSelection(paths.size === 0 ? null : { list, anchor: path, paths });
      return;
    }
    setSelection({ list, anchor: path, paths: new Set([path]) });
  };

  const onRowKeyDown = (list: StagingListKind, file: VcsStagingFile, event: KeyboardEvent) => {
    const files = lists[list];
    const index = files.findIndex((entry) => entry.path === file.path);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = files[index + (event.key === "ArrowDown" ? 1 : -1)];
      if (next) {
        select(list, next.path, event);
        document.getElementById(rowId(list, next.path))?.focus();
      }
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const chosen = selectedFiles(list);
      void move(list, chosen.length > 0 ? chosen : [file]);
    }
  };

  const onDragStart = (list: StagingListKind, file: VcsStagingFile, event: DragEvent) => {
    const chosen =
      selection?.list === list && selection.paths.has(file.path) ? selectedFiles(list) : [file];
    if (!(selection?.list === list && selection.paths.has(file.path))) {
      setSelection({ list, anchor: file.path, paths: new Set([file.path]) });
    }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(
      DRAG_MIME,
      JSON.stringify({ from: list, paths: chosen.map((entry) => entry.path) }),
    );
  };

  const onDrop = (target: StagingListKind, event: DragEvent) => {
    setDropTarget(null);
    const raw = event.dataTransfer.getData(DRAG_MIME);
    if (!raw) return;
    event.preventDefault();
    const payload = JSON.parse(raw) as { from: StagingListKind; paths: string[] };
    if (payload.from === target) return;
    const paths = new Set(payload.paths);
    void move(
      payload.from,
      lists[payload.from].filter((file) => paths.has(file.path)),
    );
  };

  const hasConflicts = lists.unstaged.some((file) => file.change === "conflicted");
  const commitDisabledReason = !commitAction.isAllowed
    ? "This connection cannot change source control."
    : lists.staged.length === 0
      ? "Stage files to commit them."
      : hasConflicts
        ? "Resolve merge conflicts first."
        : null;

  if (cwd === null) {
    return <StagingMessage>Open a project to stage changes.</StagingMessage>;
  }
  if (stagingQuery.error && !staging) {
    return <StagingMessage>{stagingQuery.error}</StagingMessage>;
  }

  const renderList = (list: StagingListKind) => {
    const files = lists[list];
    const chosen = selectedFiles(list);
    const isUnstaged = list === "unstaged";
    return (
      <section
        aria-label={isUnstaged ? "Unstaged changes" : "Staged changes"}
        className={cn("flex min-h-0 flex-1 flex-col", dropTarget === list && "bg-accent/40")}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes(DRAG_MIME)) return;
          event.preventDefault();
          if (dropTarget !== list) setDropTarget(list);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null))
            setDropTarget(null);
        }}
        onDrop={(event) => onDrop(list, event)}
      >
        <header className="flex h-9 shrink-0 items-center gap-1 border-b px-3">
          <h3 className="min-w-0 flex-1 truncate text-xs font-medium">
            {isUnstaged ? "Unstaged" : "Staged"}
            <span className="ms-1.5 text-muted-foreground tabular-nums">{files.length}</span>
          </h3>
          <Button
            size="compact"
            variant="ghost-muted"
            disabled={!canStage || moving || files.length === 0 || staging?.truncated}
            onClick={() => void move(list, files)}
          >
            {isUnstaged ? "Stage all" : "Unstage all"}
          </Button>
          <Button
            size="compact"
            variant="outline"
            disabled={!canStage || moving || chosen.length === 0}
            onClick={() => void move(list, chosen)}
          >
            {isUnstaged ? "Stage" : "Unstage"}
          </Button>
        </header>
        <div role="listbox" aria-multiselectable className="min-h-0 flex-1 overflow-y-auto py-1">
          {files.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              {isUnstaged ? "No unstaged changes." : "Nothing staged."}
            </p>
          ) : (
            files.map((file) => {
              const { name, directory } = splitPath(file.path);
              const label = CHANGE_LABELS[file.change];
              const isSelected = selection?.list === list && selection.paths.has(file.path);
              return (
                <div
                  key={file.path}
                  id={rowId(list, file.path)}
                  role="option"
                  aria-selected={isSelected}
                  tabIndex={isSelected || (selection === null && file === files[0]) ? 0 : -1}
                  draggable={canStage && !moving}
                  className={cn(
                    "flex h-6 cursor-default items-center gap-2 px-3 text-xs outline-none select-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
                    isSelected ? "bg-accent text-accent-foreground" : "hover:bg-accent/50",
                  )}
                  onClick={(event) => select(list, file.path, event)}
                  onDoubleClick={() => void move(list, [file])}
                  onKeyDown={(event) => onRowKeyDown(list, file, event)}
                  onDragStart={(event) => onDragStart(list, file, event)}
                >
                  <span className={cn("w-3 shrink-0 text-center font-mono", label.className)}>
                    {label.letter}
                  </span>
                  <span className="min-w-0 truncate">
                    {name}
                    {directory ? (
                      <span className="ms-1.5 text-muted-foreground">{directory}</span>
                    ) : null}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </section>
    );
  };

  return (
    <div className="flex h-full min-h-0 w-full">
      <div className="min-h-0 min-w-0 flex-1 overflow-auto border-e">
        {focused ? (
          <StagingFileDiff
            key={`${focused.list}:${focused.file.path}`}
            environmentId={environmentId}
            cwd={cwd}
            list={focused.list}
            file={focused.file}
            theme={theme}
          />
        ) : (
          <StagingMessage>Select a file to see its changes.</StagingMessage>
        )}
      </div>
      <aside className="flex min-h-0 w-80 max-w-[50%] shrink-0 flex-col">
        {staging?.truncated ? (
          <p className="border-b px-3 py-1.5 text-xs text-muted-foreground">
            Showing the first {lists.unstaged.length + lists.staged.length} changed files.
          </p>
        ) : null}
        {renderList("unstaged")}
        <div className="border-t" />
        {renderList("staged")}
        <footer className="shrink-0 border-t p-2">
          <Button
            className="w-full"
            size="compact"
            disabled={commitDisabledReason !== null || commitAction.isPending}
            title={commitDisabledReason ?? "Commit staged changes with a generated message"}
            onClick={() => void commit()}
          >
            {commitAction.isPending ? "Committing..." : "Commit"}
          </Button>
        </footer>
      </aside>
    </div>
  );
}

function rowId(list: StagingListKind, path: string) {
  return `staging-${list}-${path}`;
}

function StagingMessage(props: { readonly children: React.ReactNode }) {
  return (
    <div className="flex h-full min-h-24 items-center justify-center p-4 text-center text-xs text-muted-foreground">
      {props.children}
    </div>
  );
}

function StagingFileDiff(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly list: StagingListKind;
  readonly file: VcsStagingFile;
  readonly theme: "light" | "dark";
}) {
  const { file } = props;
  const conflicted = file.change === "conflicted";
  const contents = useEnvironmentQuery(
    conflicted
      ? null
      : vcsEnvironment.stagingFileContents({
          environmentId: props.environmentId,
          input: {
            cwd: props.cwd,
            sourceKind: props.list,
            changeType: changeTypeOf(file),
            baseRef: null,
            headRef: null,
            oldPath: file.previousPath ?? file.path,
            newPath: file.path,
          },
        }),
  );
  if (conflicted) {
    return <StagingMessage>Resolve the conflict, then stage the file.</StagingMessage>;
  }
  if (contents.error && !contents.data) return <StagingMessage>{contents.error}</StagingMessage>;
  if (!contents.data) return null;
  const diff = parseDiffFromFile(
    { name: file.previousPath ?? file.path, contents: contents.data.oldContents },
    { name: file.path, contents: contents.data.newContents },
  );
  return (
    <FileDiff
      fileDiff={diff}
      options={{
        diffStyle: "unified",
        theme: resolveDiffThemeName(props.theme),
        overflow: "wrap",
        preferredHighlighter: PREFERRED_HIGHLIGHTER,
      }}
    />
  );
}
