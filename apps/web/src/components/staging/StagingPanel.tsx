import { useAtomMount, useAtomValue } from "@effect/atom-react";
import { parseDiffFromFile } from "@pierre/diffs";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  changeRequestTerminologyFor,
  requiresDefaultBranchConfirmation,
  VcsActionRemoteFailureError,
} from "@t3tools/client-runtime/state/vcs";
import type {
  EnvironmentId,
  ReviewDiffFileContentsInput,
  ScopedThreadRef,
  VcsStagingFile,
} from "@t3tools/contracts";
import {
  ChevronDown,
  ChevronsDownIcon,
  ChevronsUpIcon,
  FlaskConicalOffIcon,
  FolderTreeIcon,
  PilcrowIcon,
  SearchIcon,
  TextWrapIcon,
} from "lucide-react";
import { Schema } from "effect";
import { isTestChangedFile } from "@t3tools/shared/changedFileKind";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import {
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { flushSync } from "react-dom";

import { PierreEntryIcon } from "~/components/chat/PierreEntryIcon";
import { StartTruncatedPath } from "~/components/StartTruncatedPath";
import { AnnotatableCodeView } from "~/components/diffs/AnnotatableCodeView";
import { useHideTestFiles } from "~/components/diffs/useHideTestFiles";
import type { DraftId } from "~/composerDraftStore";
import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { toastManager } from "~/components/ui/toast";
import { Toggle } from "~/components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useComposerHandleContext } from "~/composerHandleContext";
import { joinHostPath } from "~/components/files/filePath";
import { resolveDiffPathForWorkspace } from "~/diffFileActions";
import { useFileContextMenu, type FileContextMenuAction } from "~/fileContextMenu";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { readLocalApi } from "~/localApi";
import { useClientSettings } from "~/hooks/useSettings";
import { useRenderedAppearance } from "~/hooks/useTheme";
import {
  buildFileDiffContentVersion,
  buildFileDiffIdentityKey,
  resolveDiffThemeName,
} from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import { cn, randomUUID } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { useGitStackedAction } from "~/state/sourceControlActions";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsActionManager, vcsEnvironment, vcsStatusRevalidation } from "~/state/vcs";

import {
  StagingCommitControl,
  type StagingCommitChoice,
  type StagingCommitChoiceId,
} from "./StagingCommitControl";

import {
  stagingDirectoryKeysUnder,
  stagingFilesForKeys,
  stagingRows,
  stagingSuccessorKey,
  stagingToggleKey,
  type StagingRow,
  type StagingView,
} from "./stagingTree";

type StagingListKind = "unstaged" | "staged";
const isRemoteActionFailure = Schema.is(VcsActionRemoteFailureError);

/** Keys are row keys: file paths, or directory paths ending in a slash. */
interface StagingSelection {
  readonly list: StagingListKind;
  readonly keys: ReadonlySet<string>;
  readonly anchor: string;
}

const CHANGE_LABELS: Record<VcsStagingFile["change"], { letter: string; className: string }> = {
  added: { letter: "A", className: "text-diff-addition-foreground" },
  untracked: { letter: "?", className: "text-diff-addition-foreground" },
  modified: { letter: "M", className: "text-info-foreground" },
  "type-changed": { letter: "T", className: "text-warning-foreground" },
  deleted: { letter: "D", className: "text-diff-deletion-foreground" },
  renamed: { letter: "R", className: "text-warning-foreground" },
  copied: { letter: "C", className: "text-diff-addition-foreground" },
  conflicted: { letter: "U", className: "text-destructive-foreground" },
};

const DRAG_MIME = "application/x-t3-staging";
const StagingViewSchema = Schema.Literals(["list", "tree"]);
const DEFAULT_LISTS_WIDTH = 320;
const MIN_PANE_WIDTH = 200;
const DEFAULT_LIST_SPLIT = 0.5;
const MIN_LIST_SPLIT = 0.1;

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

export function StagingPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string | null;
  readonly repositoryRoot: string | undefined;
  readonly visible: boolean;
  /** The same composer draft used by the thread's Diff panel for review comments. */
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
}) {
  const { environmentId, cwd, repositoryRoot } = props;
  const theme = useRenderedAppearance();
  const [storedSelection, setSelection] = useState<StagingSelection | null>(null);
  const [dropTarget, setDropTarget] = useState<StagingListKind | null>(null);
  const [view, setView] = useLocalStorage<StagingView, StagingView>(
    "t3code:staging-view",
    "list",
    StagingViewSchema,
  );
  const settings = useClientSettings((settings) => ({
    diffIgnoreWhitespace: settings.diffIgnoreWhitespace,
    wordWrap: settings.wordWrap,
  }));
  const [wordWrap, setWordWrap] = useState(settings.wordWrap);
  const [diffIgnoreWhitespace, setDiffIgnoreWhitespace] = useState(settings.diffIgnoreWhitespace);
  const [hideTestFiles, setHideTestFiles] = useHideTestFiles();
  const [filter, setFilter] = useState<string | null>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [storedListsWidth, setListsWidth] = useLocalStorage<number, number>(
    "t3code:staging-lists-width",
    DEFAULT_LISTS_WIDTH,
    Schema.Finite,
  );
  const [storedListSplit, setListSplit] = useLocalStorage<number, number>(
    "t3code:staging-list-split",
    DEFAULT_LIST_SPLIT,
    Schema.Finite,
  );
  const listsWidth = Math.max(storedListsWidth, MIN_PANE_WIDTH);
  const listSplit = clamp(storedListSplit, MIN_LIST_SPLIT, 1 - MIN_LIST_SPLIT);
  const asideRef = useRef<HTMLElement>(null);
  const listsRef = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState<Record<StagingListKind, ReadonlySet<string>>>({
    unstaged: new Set(),
    staged: new Set(),
  });

  // Brings in edits and `git add` runs made outside T3 Code when the window regains focus.
  useAtomMount(vcsStatusRevalidation(cwd === null ? null : { environmentId, cwd }));
  const stagingQuery = useEnvironmentQuery(
    cwd === null || !props.visible
      ? null
      : vcsEnvironment.stagingStatus({ environmentId, input: { cwd } }),
  );
  const staging = stagingQuery.data;
  // Moved files leave their list right away; waiting for the refetch would put the
  // successor's highlight on the row below for a few frames.
  const [moved, setMoved] = useState<{
    readonly list: StagingListKind;
    readonly paths: ReadonlySet<string>;
    readonly staging: typeof staging;
  } | null>(null);
  const isMovedAway = (list: StagingListKind, file: VcsStagingFile) =>
    moved !== null &&
    moved.staging === staging &&
    moved.list === list &&
    moved.paths.has(file.path);
  const query = filter?.trim().toLowerCase() ?? "";
  const matches = (file: VcsStagingFile) => query === "" || file.path.toLowerCase().includes(query);
  const testFileCount = new Set(
    [...(staging?.unstaged ?? []), ...(staging?.staged ?? [])]
      .map((file) => file.path)
      .filter(isTestChangedFile),
  ).size;
  const hidingTests = hideTestFiles && testFileCount > 0;
  const shows = (file: VcsStagingFile) =>
    matches(file) && !(hidingTests && isTestChangedFile(file.path));
  // Everything that acts on rows, including folder moves and select-all, sees only shown files.
  const lists: Record<StagingListKind, ReadonlyArray<VcsStagingFile>> = {
    unstaged: (staging?.unstaged ?? []).filter(
      (file) => shows(file) && !isMovedAway("unstaged", file),
    ),
    staged: (staging?.staged ?? []).filter((file) => shows(file) && !isMovedAway("staged", file)),
  };
  const rows: Record<StagingListKind, ReadonlyArray<StagingRow>> = {
    unstaged: stagingRows(lists.unstaged, view, collapsed.unstaged),
    staged: stagingRows(lists.staged, view, collapsed.staged),
  };
  // Switching views, collapsing or folding can hide selected rows; only visible rows stay selected.
  const selection = (() => {
    if (storedSelection === null) return null;
    const visible = new Set(rows[storedSelection.list].map((row) => row.key));
    const keys = new Set([...storedSelection.keys].filter((key) => visible.has(key)));
    const [first] = keys;
    if (first === undefined) return null;
    const anchor = keys.has(storedSelection.anchor) ? storedSelection.anchor : first;
    return { list: storedSelection.list, keys, anchor };
  })();
  // A selected folder moves everything below it, so its descendants show as selected too.
  const isRowSelected = (list: StagingListKind, key: string) =>
    selection?.list === list &&
    [...selection.keys].some(
      (selected) => selected === key || (selected.endsWith("/") && key.startsWith(selected)),
    );

  const canStage = useAtomValue(vcsEnvironment.stagePaths.permissionAtom(environmentId));
  const stagePaths = useAtomCommand(vcsEnvironment.stagePaths);
  const unstagePaths = useAtomCommand(vcsEnvironment.unstagePaths);
  const discardPaths = useAtomCommand(vcsEnvironment.discardPaths);
  const fileContextMenu = useFileContextMenu(environmentId);
  const composerRef = useComposerHandleContext();
  const [moving, setMoving] = useState(false);
  const commitAction = useGitStackedAction({ environmentId, cwd });
  const refreshStatus = useAtomCommand(vcsEnvironment.refreshStatus, { reportFailure: false });
  const gitStatusQuery = useEnvironmentQuery(
    cwd === null ? null : vcsEnvironment.status({ environmentId, input: { cwd } }),
  );
  const gitStatus = gitStatusQuery.data;
  const gitActionState = useAtomValue(vcsActionManager.stateAtom({ environmentId, cwd }));
  const busyLabel = gitActionState.isRunning
    ? (gitActionState.currentLabel ?? "Running source control action...")
    : commitAction.isPending
      ? "Running source control action..."
      : null;

  const selectedFiles = (list: StagingListKind) =>
    selection?.list === list ? stagingFilesForKeys(lists[list], selection.keys) : [];
  const rowFiles = (row: StagingRow) => (row.kind === "file" ? [row.file] : row.files);
  const focused =
    selection === null
      ? null
      : (() => {
          const file = lists[selection.list].find((entry) => entry.path === selection.anchor);
          return file ? { list: selection.list, file } : null;
        })();

  const move = (from: StagingListKind, files: ReadonlyArray<VcsStagingFile>) =>
    applyToFiles(
      from,
      files,
      from === "unstaged" ? stagePaths : unstagePaths,
      from === "unstaged" ? "Stage failed" : "Unstage failed",
    );

  const applyToFiles = async (
    from: StagingListKind,
    files: ReadonlyArray<VcsStagingFile>,
    command: typeof stagePaths,
    failureTitle: string,
  ) => {
    if (cwd === null || files.length === 0 || moving || !canStage) return;
    setMoving(true);
    const movedPaths = new Set(files.map((file) => file.path));
    const remainingRows = stagingRows(
      lists[from].filter((file) => !movedPaths.has(file.path)),
      view,
      collapsed[from],
    );
    const next = stagingSuccessorKey(rows[from], remainingRows, movedPaths);
    const result = await command({ environmentId, input: { cwd, paths: pathsFor(files) } });
    setMoving(false);
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: failureTitle,
        description: error instanceof Error ? error.message : "An error occurred.",
      });
      return;
    }
    flushSync(() => {
      setMoved({ list: from, paths: movedPaths, staging });
      setSelection(next ? { list: from, anchor: next, keys: new Set([next]) } : null);
    });
    if (next) document.getElementById(rowId(from, next))?.focus();
  };

  const runCommitAction = async (action: StagingCommitChoiceId) => {
    const choice = commitChoices.find((entry) => entry.id === action);
    if (!choice || choice.disabledReason != null || busyLabel !== null) return;
    const includesCommit =
      action === "commit" || action === "commit_push" || action === "commit_push_pr";
    if (requiresDefaultBranchConfirmation(action, gitStatus?.isDefaultRef ?? false)) {
      const confirmed = await readLocalApi()?.dialogs.confirm(
        `Push to default branch "${gitStatus?.refName}"? This publishes all unpushed commits on this branch.${includesCommit ? " Staged changes will be committed first." : ""}`,
      );
      if (!confirmed) return;
    }
    const result = await commitAction.run({
      actionId: randomUUID(),
      action,
      ...(includesCommit ? { stagedOnly: true } : {}),
    });
    if (result._tag === "Failure") {
      if (cwd !== null) void refreshStatus({ environmentId, input: { cwd } });
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      const phase = isRemoteActionFailure(error) ? error.phase : null;
      toastManager.add({
        type: "error",
        title:
          phase === "push"
            ? "Push failed"
            : phase === "pr"
              ? `${terminology.shortLabel} creation failed`
              : phase === "commit" || action === "commit"
                ? "Commit failed"
                : "Source control action failed",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
      return;
    }
    if (includesCommit) setSelection(null);
    toastManager.add({
      type: "success",
      title: result.value.toast.title,
      ...(result.value.toast.description ? { description: result.value.toast.description } : {}),
    });
  };

  const select = (list: StagingListKind, key: string, event: MouseEvent | KeyboardEvent) => {
    const extend = event.metaKey || event.ctrlKey;
    if (selection?.list === list && event.shiftKey) {
      const keys = rows[list].map((row) => row.key);
      const from = keys.indexOf(selection.anchor);
      const to = keys.indexOf(key);
      const [start, end] = from < to ? [from, to] : [to, from];
      setSelection({ list, anchor: key, keys: new Set(keys.slice(start, end + 1)) });
      return;
    }
    if (selection?.list === list && extend) {
      const keys = stagingToggleKey(rows[list], selection.keys, key);
      setSelection(keys.size === 0 ? null : { list, anchor: key, keys });
      return;
    }
    setSelection({ list, anchor: key, keys: new Set([key]) });
  };

  const setExpanded = (list: StagingListKind, key: string, expanded: boolean, deep: boolean) => {
    const keys = deep ? stagingDirectoryKeysUnder(lists[list], key) : [key];
    setCollapsed((current) => {
      const next = new Set(current[list]);
      for (const directory of keys) {
        if (expanded) next.delete(directory);
        else next.add(directory);
      }
      return { ...current, [list]: next };
    });
  };

  const focusRow = (list: StagingListKind, row: StagingRow, event: KeyboardEvent) => {
    select(list, row.key, event);
    document.getElementById(rowId(list, row.key))?.focus();
  };

  const copyPaths = (keys: Iterable<string>) =>
    writeTextToClipboard([...keys].map((key) => key.replace(/\/$/, "")).join("\n")).catch(() =>
      toastManager.add({ type: "error", title: "Failed to copy path" }),
    );

  const onRowKeyDown = (list: StagingListKind, row: StagingRow, event: KeyboardEvent) => {
    const listRows = rows[list];
    const index = listRows.findIndex((entry) => entry.key === row.key);
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      event.preventDefault();
      setSelection({ list, anchor: row.key, keys: new Set(listRows.map((entry) => entry.key)) });
    } else if (
      (event.metaKey || event.ctrlKey) &&
      !event.shiftKey &&
      !event.altKey &&
      event.key.toLowerCase() === "c"
    ) {
      event.preventDefault();
      const keys = selection?.list === list ? selection.keys : new Set([row.key]);
      void copyPaths(listRows.map((entry) => entry.key).filter((key) => keys.has(key)));
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = listRows[index + (event.key === "ArrowDown" ? 1 : -1)];
      if (next) focusRow(list, next, event);
    } else if (event.key === "ArrowRight" && row.kind === "directory") {
      event.preventDefault();
      if (!row.expanded || event.altKey) setExpanded(list, row.key, true, event.altKey);
      else if (listRows[index + 1]) focusRow(list, listRows[index + 1]!, event);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (row.kind === "directory" && (row.expanded || event.altKey)) {
        setExpanded(list, row.key, false, event.altKey);
        return;
      }
      const parent = listRows.findLast(
        (entry, entryIndex) => entryIndex < index && entry.depth < row.depth,
      );
      if (parent) focusRow(list, parent, event);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const chosen = selectedFiles(list);
      void move(list, chosen.length > 0 ? chosen : rowFiles(row));
    }
  };

  const discard = async (files: ReadonlyArray<VcsStagingFile>) => {
    const api = readLocalApi();
    if (!api || files.length === 0) return;
    const [only] = files;
    const subject = files.length === 1 && only ? `"${only.path}"` : `${files.length} files`;
    const deletes = files.some((file) => file.change === "untracked");
    const confirmed = await api.dialogs.confirm(
      `Discard changes to ${subject}?${deletes ? " Untracked files will be deleted." : ""} This cannot be undone.`,
      { variant: "destructive" },
    );
    if (confirmed) await applyToFiles("unstaged", files, discardPaths, "Discard failed");
  };

  const onRowContextMenu = async (list: StagingListKind, row: StagingRow, event: MouseEvent) => {
    const api = readLocalApi();
    if (!api || cwd === null) return;
    event.preventDefault();
    const inSelection = isRowSelected(list, row.key);
    const keys = inSelection && selection ? [...selection.keys] : [row.key];
    if (!inSelection) setSelection({ list, anchor: row.key, keys: new Set([row.key]) });
    const files = stagingFilesForKeys(lists[list], new Set(keys));
    const paths = keys.map((key) => key.replace(/\/$/, ""));
    // Status paths are repository-relative and may sit outside a project in a repo subfolder.
    const root = repositoryRoot ?? cwd;
    const target = { environmentId, filePath: row.key.replace(/\/$/, ""), workspaceRoot: root };
    const fileItems = fileContextMenu.buildItems(target);
    const discardable = list === "unstaged" ? files.filter((f) => f.change !== "conflicted") : [];
    const clicked = await api.contextMenu.show(
      [
        ...fileItems,
        { id: "copy-path", label: paths.length === 1 ? "Copy path" : "Copy paths" },
        { id: "add-to-chat", label: "Add to chat" },
        {
          id: "move",
          label: list === "unstaged" ? "Stage" : "Unstage",
          separatorBefore: true,
          disabled: !canStage,
        },
        ...(discardable.length > 0
          ? [
              {
                id: "discard",
                label: "Discard changes...",
                destructive: true,
                disabled: !canStage,
              },
            ]
          : []),
      ],
      { x: event.clientX, y: event.clientY },
    );
    if (clicked === null) return;
    if (fileItems.some((item) => item.id === clicked) || clicked.startsWith("editor:")) {
      await fileContextMenu.activate(clicked as FileContextMenuAction, target);
    } else if (clicked === "copy-path") {
      await copyPaths(keys);
    } else if (clicked === "add-to-chat") {
      const mentions = paths.map((filePath) =>
        serializeComposerFileLink(
          resolveDiffPathForWorkspace({ filePath, workspaceRoot: cwd, repositoryRoot }) ??
            joinHostPath(root, filePath),
        ),
      );
      const composer = composerRef?.current;
      const inserted = composer?.insertTextAtEnd(`${mentions.join(" ")} `, {
        ensureLeadingBoundary: true,
      });
      if (!inserted) {
        toastManager.add({
          type: "error",
          title: "Unable to add to chat",
          description: composer
            ? "The chat isn't ready to accept input right now."
            : "Open a chat for this project and try again.",
        });
      }
    } else if (clicked === "move") {
      await move(list, files);
    } else if (clicked === "discard") {
      await discard(discardable);
    }
  };

  const onDragStart = (list: StagingListKind, row: StagingRow, event: DragEvent) => {
    const inSelection = selection !== null && isRowSelected(list, row.key);
    const keys = inSelection ? [...selection.keys] : [row.key];
    if (!inSelection) setSelection({ list, anchor: row.key, keys: new Set([row.key]) });
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(DRAG_MIME, JSON.stringify({ from: list, keys }));
  };

  const onDrop = (target: StagingListKind, event: DragEvent) => {
    setDropTarget(null);
    const raw = event.dataTransfer.getData(DRAG_MIME);
    if (!raw) return;
    event.preventDefault();
    const payload = JSON.parse(raw) as { from: StagingListKind; keys: string[] };
    if (payload.from === target) return;
    void move(payload.from, stagingFilesForKeys(lists[payload.from], new Set(payload.keys)));
  };

  const hasConflicts = (staging?.unstaged ?? []).some((file) => file.change === "conflicted");
  const commitDisabledReason = !commitAction.isAllowed
    ? "This connection cannot change source control."
    : moving
      ? "Wait for staged files to finish updating."
      : (staging?.staged.length ?? 0) === 0
        ? "Stage files to commit them."
        : hasConflicts
          ? "Resolve merge conflicts first."
          : null;
  const terminology = changeRequestTerminologyFor(gitStatus ?? null);
  const publishDisabledReason = !commitAction.isAllowed
    ? "This connection cannot change source control."
    : moving
      ? "Wait for staged files to finish updating."
      : !gitStatus
        ? "Git status is unavailable."
        : gitStatus.refName === null
          ? "Check out a branch before publishing."
          : gitStatus.behindCount > 0
            ? "Branch is behind upstream. Pull/rebase before publishing."
            : null;
  const prDisabledReason =
    publishDisabledReason ??
    (gitStatus?.isDefaultRef
      ? `Check out a feature branch before creating a ${terminology.singular}.`
      : null);
  const hasStagedFiles = (staging?.staged.length ?? 0) > 0;
  const commitChoices: StagingCommitChoice[] = [
    { id: "commit", label: "Commit", disabledReason: commitDisabledReason },
  ];
  if (gitStatus?.hasPrimaryRemote) {
    commitChoices.push({
      id: "commit_push",
      label: "Commit & push",
      disabledReason: commitDisabledReason ?? publishDisabledReason,
    });
    if (gitStatus.pr?.state !== "open") {
      commitChoices.push({
        id: "commit_push_pr",
        label: `Commit, push & create ${terminology.shortLabel}`,
        disabledReason: commitDisabledReason ?? prDisabledReason,
      });
    }
    if (!hasStagedFiles) {
      commitChoices.push({
        id: "push",
        label: "Push",
        disabledReason:
          publishDisabledReason ?? (gitStatus.aheadCount > 0 ? null : "No local commits to push."),
      });
      if (gitStatus.pr?.state !== "open") {
        commitChoices.push({
          id: "create_pr",
          label: `Create ${terminology.shortLabel}`,
          disabledReason:
            prDisabledReason ??
            ((gitStatus.aheadOfDefaultCount ?? gitStatus.aheadCount) > 0
              ? null
              : `No commits to include in a ${terminology.singular}.`),
        });
      }
    }
  }

  if (cwd === null) {
    return <StagingMessage>Open a project to stage changes.</StagingMessage>;
  }
  if (stagingQuery.error && !staging) {
    return <StagingMessage>{stagingQuery.error}</StagingMessage>;
  }

  // Drags write the DOM directly and commit once on release, so moves do not re-render the lists.
  const applyListsWidth = (width: number) =>
    asideRef.current?.style.setProperty("width", `${width}px`);
  const applyListSplit = (split: number) =>
    listsRef.current?.style.setProperty("--staging-split", String(split));
  const resizeLists = (event: PointerEvent) => {
    const panel = panelRef.current?.getBoundingClientRect();
    if (!panel) return null;
    const width = clamp(panel.right - event.clientX, MIN_PANE_WIDTH, panel.width - MIN_PANE_WIDTH);
    applyListsWidth(width);
    return width;
  };
  const resizeListSplit = (event: PointerEvent) => {
    const rect = listsRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const split = clamp(
      (event.clientY - rect.top) / rect.height,
      MIN_LIST_SPLIT,
      1 - MIN_LIST_SPLIT,
    );
    applyListSplit(split);
    return split;
  };

  const openFilter = () => {
    setFilter((current) => current ?? "");
    queueMicrotask(() => filterInputRef.current?.select());
  };
  const closeFilter = () => {
    // The field unmounts, so keyboard focus returns to the lists instead of the page.
    const hadFocus = document.activeElement === filterInputRef.current;
    flushSync(() => setFilter(null));
    if (hadFocus) {
      panelRef.current?.querySelector<HTMLElement>('[role="option"][tabindex="0"]')?.focus();
    }
  };

  const filterToggle = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            aria-label="Filter files"
            variant="ghost"
            size="sm"
            pressed={filter !== null}
            onPressedChange={(pressed) => (pressed ? openFilter() : closeFilter())}
          />
        }
      >
        <SearchIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">Filter files</TooltipPopup>
    </Tooltip>
  );

  const filterStrip =
    filter === null ? null : (
      <div className="shrink-0 border-b border-border p-2">
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            ref={filterInputRef}
            type="search"
            size="sm"
            autoFocus
            aria-label="Filter changed files"
            placeholder="Filter"
            spellCheck={false}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </InputGroup>
      </div>
    );

  const viewToggle = (
    <Tooltip>
      <TooltipTrigger
        render={
          <Toggle
            aria-label={view === "tree" ? "Show as list" : "Show as tree"}
            variant="ghost"
            size="sm"
            pressed={view === "tree"}
            onPressedChange={(pressed) => setView(pressed ? "tree" : "list")}
          />
        }
      >
        <FolderTreeIcon className="size-3.5" />
      </TooltipTrigger>
      <TooltipPopup side="top">{view === "tree" ? "Show as list" : "Show as tree"}</TooltipPopup>
    </Tooltip>
  );

  const diffToggles = (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              aria-label={wordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"}
              variant="ghost"
              size="sm"
              pressed={wordWrap}
              onPressedChange={(pressed) => setWordWrap(Boolean(pressed))}
            />
          }
        >
          <TextWrapIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="top">
          {wordWrap ? "Disable line wrapping" : "Enable line wrapping"}
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              aria-label={
                diffIgnoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"
              }
              variant="ghost"
              size="sm"
              pressed={diffIgnoreWhitespace}
              onPressedChange={(pressed) => setDiffIgnoreWhitespace(Boolean(pressed))}
            />
          }
        >
          <PilcrowIcon className="size-3.5" />
        </TooltipTrigger>
        <TooltipPopup side="top">
          {diffIgnoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"}
        </TooltipPopup>
      </Tooltip>
      {testFileCount > 0 && (
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                aria-label="Hide test files"
                variant="ghost"
                size="sm"
                pressed={hideTestFiles}
                onPressedChange={(pressed) => setHideTestFiles(Boolean(pressed))}
              />
            }
          >
            <FlaskConicalOffIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {hideTestFiles
              ? `Show ${testFileCount} hidden test ${testFileCount === 1 ? "file" : "files"}`
              : "Hide test files"}
          </TooltipPopup>
        </Tooltip>
      )}
    </>
  );

  const renderRow = (list: StagingListKind, row: StagingRow, isFirst: boolean) => {
    const isSelected = isRowSelected(list, row.key);
    const label = row.kind === "file" ? CHANGE_LABELS[row.file.change] : null;
    return (
      <div
        key={row.key}
        id={rowId(list, row.key)}
        role="option"
        aria-selected={isSelected}
        aria-expanded={row.kind === "directory" ? row.expanded : undefined}
        tabIndex={isSelected || (selection === null && isFirst) ? 0 : -1}
        draggable={canStage && !moving}
        style={{ paddingInlineStart: `${8 + row.depth * 16}px` }}
        className={cn(
          "relative flex h-6 cursor-default items-center gap-1.5 rounded-md pe-2 text-xs text-foreground outline-none select-none focus:ring-1 focus:ring-ring focus:ring-inset",
          isSelected ? "bg-current/12" : "hover:bg-current/7",
        )}
        onClick={(event) => select(list, row.key, event)}
        onDoubleClick={() => void move(list, rowFiles(row))}
        onKeyDown={(event) => onRowKeyDown(list, row, event)}
        onDragStart={(event) => onDragStart(list, row, event)}
        onContextMenu={(event) => void onRowContextMenu(list, row, event)}
      >
        {Array.from({ length: row.depth }, (_, level) => (
          <span
            key={level}
            aria-hidden
            className="absolute inset-y-0 w-px bg-muted-foreground/25"
            style={{ insetInlineStart: `${15 + level * 16}px` }}
          />
        ))}
        {row.kind === "directory" ? (
          <>
            <span
              aria-hidden
              className="flex size-4 shrink-0 items-center justify-center text-muted-foreground"
              onClick={(event) => {
                event.stopPropagation();
                setExpanded(list, row.key, !row.expanded, event.altKey);
              }}
              onDoubleClick={(event) => event.stopPropagation()}
            >
              <ChevronDown className={cn("size-3.5", !row.expanded && "-rotate-90")} />
            </span>
            <span className="min-w-0 flex-1 truncate">{row.name}</span>
          </>
        ) : (
          <>
            <PierreEntryIcon pathValue={row.file.path} kind="file" theme={theme} />
            {view === "list" ? (
              <StartTruncatedPath path={row.file.path} className={cn("flex-1", label?.className)} />
            ) : (
              <Tooltip>
                <TooltipTrigger
                  render={<span className={cn("min-w-0 flex-1 truncate", label?.className)} />}
                >
                  {row.name}
                </TooltipTrigger>
                <TooltipPopup>{row.file.path}</TooltipPopup>
              </Tooltip>
            )}
            <span className={cn("w-3 shrink-0 text-center font-mono", label?.className)}>
              {label?.letter}
            </span>
          </>
        )}
      </div>
    );
  };

  const renderList = (list: StagingListKind) => {
    const files = lists[list];
    const chosen = selectedFiles(list);
    const isUnstaged = list === "unstaged";
    return (
      <section
        aria-label={isUnstaged ? "Unstaged changes" : "Staged changes"}
        className={cn("flex min-h-0 basis-0 flex-col", dropTarget === list && "bg-accent/40")}
        style={{
          flexGrow: isUnstaged ? "var(--staging-split)" : "calc(1 - var(--staging-split))",
        }}
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
        <header className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border px-2 text-xs text-muted-foreground">
          <h3 className="min-w-0 flex-1 truncate px-1 font-medium text-foreground">
            {isUnstaged ? "Unstaged" : "Staged"}
          </h3>
          {files.length > 0 ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    aria-label={isUnstaged ? "Stage all" : "Unstage all"}
                    variant="ghost"
                    size="icon-xs"
                    // A truncated status does not list every file, so "all" would be a lie.
                    disabled={!canStage || moving || staging?.truncated !== false}
                    onClick={() => void move(list, files)}
                  />
                }
              >
                {isUnstaged ? (
                  <ChevronsDownIcon className="size-3.5" />
                ) : (
                  <ChevronsUpIcon className="size-3.5" />
                )}
              </TooltipTrigger>
              <TooltipPopup side="top">
                {`${isUnstaged ? "Stage" : "Unstage"} all${query === "" && !hidingTests ? "" : " shown"}`}
              </TooltipPopup>
            </Tooltip>
          ) : null}
          <Button
            size="compact"
            variant="outline"
            disabled={!canStage || moving || chosen.length === 0}
            onClick={() => void move(list, chosen)}
          >
            {isUnstaged ? "Stage" : "Unstage"}
          </Button>
        </header>
        <div role="listbox" aria-multiselectable className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {files.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">
              {(staging?.[list] ?? []).some((file) => matches(file) && !isMovedAway(list, file))
                ? "Only hidden test files."
                : (staging?.[list].length ?? 0) > 0
                  ? "No matches."
                  : isUnstaged
                    ? "No unstaged changes."
                    : "Nothing staged."}
            </p>
          ) : (
            rows[list].map((row, index) => renderRow(list, row, index === 0))
          )}
        </div>
      </section>
    );
  };

  return (
    <div
      ref={panelRef}
      className="flex h-full min-h-0 w-full"
      data-staging-panel
      onKeyDown={(event) => {
        if (event.defaultPrevented) return;
        if (event.key === "Escape" && filter !== null) {
          event.preventDefault();
          closeFilter();
          return;
        }
        // Inside the panel, find filters the lists instead of opening the browser or thread find.
        if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
        if (event.key.toLowerCase() !== "f") return;
        event.preventDefault();
        openFilter();
      }}
    >
      <div className="min-h-0 min-w-0 flex-1 overflow-auto border-e border-border">
        {focused ? (
          <StagingFileDiff
            key={`${focused.list}:${focused.file.path}`}
            environmentId={environmentId}
            cwd={cwd}
            list={focused.list}
            file={focused.file}
            theme={theme}
            wordWrap={wordWrap}
            ignoreWhitespace={diffIgnoreWhitespace}
            composerDraftTarget={props.composerDraftTarget}
          />
        ) : (
          <StagingMessage>Select a file to see its changes.</StagingMessage>
        )}
      </div>
      <aside
        ref={asideRef}
        // Matches the drag clamp, so a width saved in a wider window still leaves the diff its minimum.
        className="relative flex min-h-0 max-w-[calc(100%-200px)] shrink-0 flex-col"
        style={{ width: listsWidth }}
      >
        <ResizeHandle
          orientation="vertical"
          label="Resize file lists"
          onResize={resizeLists}
          onCommit={setListsWidth}
          onCancel={() => applyListsWidth(listsWidth)}
          onReset={() => setListsWidth(DEFAULT_LISTS_WIDTH)}
        />
        <div className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border px-2">
          {filterToggle}
          <span className="flex-1" />
          {diffToggles}
          {viewToggle}
        </div>
        {filterStrip}
        {staging?.truncated ? (
          <p className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
            Showing the first {staging.unstaged.length + staging.staged.length} changed files.
          </p>
        ) : null}
        <div
          ref={listsRef}
          className="flex min-h-0 flex-1 flex-col"
          style={{ "--staging-split": listSplit } as CSSProperties}
        >
          {renderList("unstaged")}
          <div className="relative border-t border-border">
            <ResizeHandle
              orientation="horizontal"
              label="Resize staged and unstaged lists"
              onResize={resizeListSplit}
              onCommit={setListSplit}
              onCancel={() => applyListSplit(listSplit)}
              onReset={() => setListSplit(DEFAULT_LIST_SPLIT)}
            />
          </div>
          {renderList("staged")}
        </div>
        <footer className="shrink-0 border-t border-border p-2">
          <StagingCommitControl
            commit={commitChoices[0]!}
            moreChoices={commitChoices.slice(1)}
            busyLabel={busyLabel}
            onSelect={(action) => void runCommitAction(action)}
          />
        </footer>
      </aside>
    </div>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** Double-click restores the default size. */
function ResizeHandle(props: {
  readonly orientation: "vertical" | "horizontal";
  readonly label: string;
  /** Applies the size under the pointer and returns it. */
  readonly onResize: (event: PointerEvent) => number | null;
  readonly onCommit: (size: number) => void;
  readonly onCancel: () => void;
  readonly onReset: () => void;
}) {
  const dragging = useRef(false);
  const size = useRef<number | null>(null);
  const end = (commit: boolean) => {
    if (!dragging.current) return;
    dragging.current = false;
    const final = size.current;
    size.current = null;
    if (!commit) props.onCancel();
    else if (final !== null) props.onCommit(final);
  };
  return (
    <div
      role="separator"
      aria-orientation={props.orientation}
      aria-label={props.label}
      className={cn(
        "absolute z-10 touch-none",
        props.orientation === "vertical"
          ? "inset-y-0 -start-1 w-2 cursor-col-resize"
          : "inset-x-0 -top-1 h-2 cursor-row-resize",
      )}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        dragging.current = true;
        // Keeps moves arriving once the pointer leaves the thin handle.
        if (event.isTrusted) event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (dragging.current) size.current = props.onResize(event) ?? size.current;
      }}
      onPointerUp={() => end(true)}
      onPointerCancel={() => end(false)}
      onLostPointerCapture={() => end(true)}
      onDoubleClick={props.onReset}
    />
  );
}

function rowId(list: StagingListKind, key: string) {
  return `staging-${list}-${key}`;
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
  readonly wordWrap: boolean;
  readonly ignoreWhitespace: boolean;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
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
    { ignoreWhitespace: props.ignoreWhitespace },
  );
  const fileKey = buildFileDiffIdentityKey(diff);
  return (
    <AnnotatableCodeView
      codeViewKey={fileKey}
      className="h-full min-h-0 overflow-auto"
      files={[
        {
          fileDiff: diff,
          filePath: file.path,
          fileKey,
          fileVersion: buildFileDiffContentVersion(diff),
          collapsed: false,
        },
      ]}
      pendingFiles={[]}
      sectionId={`staging:${props.list}`}
      relatedSectionIds={[props.list === "staged" ? "staging:unstaged" : "staging:staged"]}
      sectionTitle={props.list === "staged" ? "Staged changes" : "Unstaged changes"}
      composerDraftTarget={props.composerDraftTarget}
      renderHeaderFilenameSuffix={() => null}
      renderHeaderPrefix={() => null}
      onFileCollapsedChange={() => {}}
      options={{
        diffStyle: "unified",
        lineDiffType: "none",
        overflow: props.wordWrap ? "wrap" : "scroll",
        theme: resolveDiffThemeName(props.theme),
        themeType: props.theme,
        preferredHighlighter: PREFERRED_HIGHLIGHTER,
      }}
    />
  );
}
