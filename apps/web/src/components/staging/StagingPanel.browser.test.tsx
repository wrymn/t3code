import {
  EnvironmentId,
  SourceControlProviderKind,
  type VcsStagingFile,
  type VcsStagingStatusResult,
  type VcsStatusResult,
} from "@t3tools/contracts";
import {
  EMPTY_VCS_ACTION_STATE,
  VcsActionRemoteFailureError,
  type VcsActionState,
} from "@t3tools/client-runtime/state/vcs";
import { Cause } from "effect";
import type { CodeViewDiffItem, SelectedLineRange } from "@pierre/diffs";
import type { ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

type ViewerProps = Omit<ComponentProps<typeof StyledDiffCodeView<unknown>>, "options"> & {
  options: {
    enableGutterUtility: boolean;
    onGutterUtilityClick: (
      range: SelectedLineRange,
      context: { item: CodeViewDiffItem<unknown> },
    ) => void;
  };
};

// Keep the comment editor and draft store real; replace only the virtualized renderer.
vi.mock("~/components/diffs/StyledDiffCodeView", () => ({
  DIFF_VIEW_UNSAFE_CSS: "",
  StyledDiffCodeView: (props: ViewerProps) =>
    props.items
      ?.filter((item) => item.type === "diff")
      .map((item) => (
        <section key={item.id}>
          <button
            disabled={!props.options.enableGutterUtility}
            onClick={() =>
              props.options.onGutterUtilityClick({ start: 1, end: 1, side: "additions" }, { item })
            }
          >
            Comment on {item.fileDiff.name}
          </button>
          {item.annotations?.map((annotation) => (
            <div key={`${annotation.side}:${annotation.lineNumber}`}>
              {props.renderAnnotation?.(annotation, item.fileDiff, item)}
            </div>
          ))}
        </section>
      )),
}));

const state = vi.hoisted(() => ({
  staging: null as unknown as VcsStagingStatusResult,
  status: null as unknown as VcsStatusResult,
  progress: null as unknown as VcsActionState,
  allowed: true,
  contents: { oldContents: "old value\n", newContents: "new value\n" },
  stage: vi.fn(),
  unstage: vi.fn(),
  discard: vi.fn(),
  commit: vi.fn(),
  refresh: vi.fn(),
  confirm: vi.fn(),
  openFile: vi.fn(),
  insertTextAtEnd: vi.fn(),
}));

vi.mock(import("~/state/vcs"), async (importOriginal) => {
  const actual = await importOriginal();
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  const command = (run: () => unknown) => ({ run, permissionAtom: () => allowed });
  return {
    ...actual,
    vcsStatusRevalidation: (() => Atom.make(0)) as never,
    vcsActionManager: {
      ...actual.vcsActionManager,
      stateAtom: (() => Atom.make(state.progress)) as never,
    },
    vcsEnvironment: {
      ...actual.vcsEnvironment,
      stagingStatus: (() => "staging-status") as never,
      status: (() => "git-status") as never,
      stagingFileContents: (() => "file-contents") as never,
      stagePaths: command(state.stage) as never,
      unstagePaths: command(state.unstage) as never,
      discardPaths: command(state.discard) as never,
      refreshStatus: command(state.refresh) as never,
    },
  };
});
vi.mock(import("~/state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuery: ((atom: unknown) =>
    atom === "staging-status"
      ? { data: state.staging }
      : atom === "git-status"
        ? { data: state.status }
        : atom === "file-contents"
          ? { data: state.contents }
          : { data: undefined }) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: ((command: { run: unknown }) => command.run) as never,
}));
vi.mock(import("~/state/sourceControlActions"), async (importOriginal) => ({
  ...(await importOriginal()),
  useGitStackedAction: (() => ({
    run: state.commit,
    isAllowed: state.allowed,
    isPending: false,
  })) as never,
}));
vi.mock(import("~/fileContextMenu"), async (importOriginal) => ({
  ...(await importOriginal()),
  useFileContextMenu: (() => ({
    buildItems: () => [{ id: "open", label: "Open" }],
    activate: state.openFile,
  })) as never,
}));
vi.mock(import("~/localApi"), async (importOriginal) => {
  const actual = await importOriginal();
  const api = actual.createLocalApi();
  return {
    ...actual,
    readLocalApi: () => ({ ...api, dialogs: { ...api.dialogs, confirm: state.confirm } }),
  };
});

// The resize test measures layout, which needs the app styles.
import "~/index.css";
import { ComposerHandleContext } from "~/composerHandleContext";
import { dismissContextMenu } from "~/contextMenuFallback";
import { render } from "../../../test/render";
import { StagingPanel } from "./StagingPanel";
import { toastManager } from "~/components/ui/toast";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import type { StyledDiffCodeView } from "~/components/diffs/StyledDiffCodeView";

const ENVIRONMENT_ID = EnvironmentId.make("env-staging");
const COMPOSER_TARGET = DraftId.make("staging-comments");
// The project is a subfolder of the repository, so status paths start with "app/".
const CWD = "/repo/app";
const SUCCESS = { _tag: "Success", value: undefined };

const file = (
  path: string,
  change: VcsStagingFile["change"],
  previousPath: string | null = null,
): VcsStagingFile => ({ path, change, previousPath }) as VcsStagingFile;

function setup(
  overrides: Partial<VcsStagingStatusResult> = {},
  statusOverrides: Partial<VcsStatusResult> = {},
  progressOverrides: Partial<VcsActionState> = {},
) {
  useComposerDraftStore.setState(useComposerDraftStore.getInitialState(), true);
  state.contents = { oldContents: "old value\n", newContents: "new value\n" };
  state.allowed = true;
  state.progress = { ...EMPTY_VCS_ACTION_STATE, ...progressOverrides };
  for (const key of ["view", "lists-width", "list-split"]) {
    localStorage.removeItem(`t3code:staging-${key}`);
  }
  state.staging = {
    unstaged: [
      file("app/src/main.ts", "modified"),
      file("app/src/util.ts", "deleted"),
      file("app/notes.md", "untracked"),
      file("README.md", "modified"),
    ],
    staged: [file("app/lib/new.ts", "renamed", "app/lib/old.ts")],
    truncated: false,
    ...overrides,
  };
  state.status = {
    isRepo: true,
    hasPrimaryRemote: false,
    isDefaultRef: false,
    refName: "feature/staging",
    hasWorkingTreeChanges: true,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...statusOverrides,
  };
  for (const command of [state.stage, state.unstage, state.discard]) {
    // A new status object stands for the refetch every index write triggers.
    command.mockReset().mockImplementation(async () => {
      state.staging = { ...state.staging };
      return SUCCESS;
    });
  }
  state.commit
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { toast: { title: "Ok" } } });
  state.confirm.mockReset();
  state.refresh.mockReset().mockResolvedValue(SUCCESS);
  state.openFile.mockReset().mockResolvedValue(undefined);
  state.insertTextAtEnd.mockReset().mockReturnValue(true);
  const composer = { current: { insertTextAtEnd: state.insertTextAtEnd } } as never;
  return render(
    <ComposerHandleContext value={composer}>
      <div style={{ width: 900, height: 600 }}>
        <StagingPanel
          composerDraftTarget={COMPOSER_TARGET}
          environmentId={ENVIRONMENT_ID}
          cwd={CWD}
          repositoryRoot="/repo"
          visible
        />
      </div>
    </ComposerHandleContext>,
  );
}

const row = (list: "unstaged" | "staged", key: string) =>
  document.getElementById(`staging-${list}-${key}`)!;
const selectedKeys = (list: "unstaged" | "staged") =>
  [...document.querySelectorAll(`[id^="staging-${list}-"][aria-selected="true"]`)].map((element) =>
    element.id.slice(`staging-${list}-`.length),
  );
const pathsInput = (paths: string[]) => ({
  environmentId: ENVIRONMENT_ID,
  input: { cwd: CWD, paths },
});

async function openMenu(list: "unstaged" | "staged", key: string) {
  row(list, key).dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }),
  );
  await expect.element(page.getByRole("menuitem").first()).toBeVisible();
  return [...document.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent);
}

async function clickMenuItem(name: string) {
  await userEvent.click(page.getByRole("menuitem", { name, exact: true }));
}

it("stages and unstages by double-click, keyboard, and folder drag", async () => {
  await using _screen = await setup();

  // Before the refetch lands, the moved row is already gone and its successor selected.
  state.stage.mockResolvedValueOnce(SUCCESS);
  await userEvent.dblClick(row("unstaged", "app/notes.md"));
  expect(state.stage).toHaveBeenCalledWith(pathsInput(["app/notes.md"]));
  await vi.waitFor(() => expect(row("unstaged", "app/notes.md")).toBeNull());
  expect(selectedKeys("unstaged")).toEqual(["README.md"]);

  // A rename moves two index entries.
  await userEvent.dblClick(row("staged", "app/lib/new.ts"));
  expect(state.unstage).toHaveBeenCalledWith(pathsInput(["app/lib/old.ts", "app/lib/new.ts"]));

  // Select-all stays inside the focused list.
  await userEvent.click(row("unstaged", "README.md"));
  await userEvent.keyboard("{ControlOrMeta>}a{/ControlOrMeta}");
  expect(selectedKeys("unstaged")).toHaveLength(4);
  expect(selectedKeys("staged")).toEqual([]);
  state.stage.mockClear();
  await userEvent.keyboard("{Enter}");
  expect(state.stage).toHaveBeenCalledWith(
    pathsInput(["app/src/main.ts", "app/src/util.ts", "app/notes.md", "README.md"]),
  );

  state.stage.mockClear();
  await userEvent.click(page.getByRole("button", { name: "Stage all" }));
  expect(state.stage).toHaveBeenCalledWith(
    pathsInput(["app/src/main.ts", "app/src/util.ts", "app/notes.md", "README.md"]),
  );

  state.unstage.mockClear();
  await userEvent.click(page.getByRole("button", { name: "Unstage all" }));
  expect(state.unstage).toHaveBeenCalledWith(pathsInput(["app/lib/old.ts", "app/lib/new.ts"]));

  await userEvent.click(page.getByRole("button", { name: "Show as tree" }));
  await vi.waitFor(() => expect(row("unstaged", "app/")).not.toBeNull());
  state.stage.mockClear();
  const dataTransfer = new DataTransfer();
  row("unstaged", "app/src/").dispatchEvent(
    new DragEvent("dragstart", { bubbles: true, dataTransfer }),
  );
  document
    .querySelector('section[aria-label="Staged changes"]')!
    .dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
  await vi.waitFor(() =>
    expect(state.stage).toHaveBeenCalledWith(pathsInput(["app/src/main.ts", "app/src/util.ts"])),
  );
});

it("hides bulk actions for empty lists", async () => {
  await using _screen = await setup({ unstaged: [], staged: [] });
  await expect.element(page.getByRole("button", { name: "Stage all" })).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Unstage all" })).not.toBeInTheDocument();
});

it("disables bulk actions when status is truncated", async () => {
  await using _screen = await setup({ truncated: true });
  await expect.element(page.getByRole("button", { name: "Stage all" })).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "Unstage all" })).toBeDisabled();
});

it("collapses a folder and everything below it with Alt", async () => {
  await using _screen = await setup();
  await userEvent.click(page.getByRole("button", { name: "Show as tree" }));
  await vi.waitFor(() => expect(row("unstaged", "app/")).not.toBeNull());

  row("unstaged", "app/").focus();
  await userEvent.keyboard("{Alt>}{ArrowLeft}{/Alt}");
  await vi.waitFor(() => expect(row("unstaged", "app/src/")).toBeNull());
  await userEvent.keyboard("{ArrowRight}");
  // A plain expand leaves the nested folder collapsed.
  await vi.waitFor(() =>
    expect(row("unstaged", "app/src/").getAttribute("aria-expanded")).toBe("false"),
  );
  await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");
  await vi.waitFor(() => expect(row("unstaged", "app/src/main.ts")).not.toBeNull());
});

it("filters both lists from find or the filter button, and acts only on matches", async () => {
  await using _screen = await setup();
  const filterInput = page.getByRole("searchbox", { name: "Filter changed files" });

  await userEvent.click(row("unstaged", "README.md"));
  await userEvent.keyboard("{ControlOrMeta>}f{/ControlOrMeta}");
  await expect.element(filterInput).toHaveFocus();
  await userEvent.keyboard(".TS");
  await vi.waitFor(() => expect(row("unstaged", "README.md")).toBeNull());
  expect(row("unstaged", "app/src/main.ts")).not.toBeNull();
  expect(row("staged", "app/lib/new.ts")).not.toBeNull();

  await userEvent.click(row("unstaged", "app/src/main.ts"));
  await userEvent.keyboard("{ControlOrMeta>}a{/ControlOrMeta}{Enter}");
  expect(state.stage).toHaveBeenCalledWith(pathsInput(["app/src/main.ts", "app/src/util.ts"]));

  // Escape closes the filter from a row as well as from the field.
  await userEvent.keyboard("{Escape}");
  await expect.element(filterInput).not.toBeInTheDocument();
  expect(row("unstaged", "README.md")).not.toBeNull();
  await userEvent.keyboard("{ControlOrMeta>}f{/ControlOrMeta}");
  await expect.element(filterInput).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(filterInput).not.toBeInTheDocument();

  await userEvent.click(page.getByRole("button", { name: "Filter files" }));
  await expect.element(filterInput).toHaveFocus();
  await userEvent.keyboard("no-matching-files");
  await expect.element(page.getByRole("button", { name: "Stage all" })).not.toBeInTheDocument();
  await expect.element(page.getByRole("button", { name: "Unstage all" })).not.toBeInTheDocument();
  await userEvent.keyboard("{ControlOrMeta>}a{/ControlOrMeta}{Backspace}");
  await expect.element(page.getByRole("button", { name: "Stage all" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Unstage all" })).toBeVisible();
});

it("offers list-specific context menu actions and confirms before discarding", async () => {
  await using _screen = await setup({
    unstaged: [file("app/notes.md", "untracked"), file("app/conflict.ts", "conflicted")],
  });
  using _menu = { [Symbol.dispose]: () => dismissContextMenu() };

  expect(await openMenu("unstaged", "app/notes.md")).toEqual([
    "Open",
    "Copy path",
    "Add to chat",
    "Stage",
    "Discard changes...",
  ]);
  await clickMenuItem("Open");
  expect(state.openFile).toHaveBeenCalledWith("open", {
    environmentId: ENVIRONMENT_ID,
    filePath: "app/notes.md",
    workspaceRoot: "/repo",
  });

  expect(await openMenu("unstaged", "app/conflict.ts")).not.toContain("Discard changes...");
  dismissContextMenu();
  expect(await openMenu("staged", "app/lib/new.ts")).toEqual([
    "Open",
    "Copy path",
    "Add to chat",
    "Unstage",
  ]);
  dismissContextMenu();

  state.confirm.mockResolvedValueOnce(false);
  await openMenu("unstaged", "app/notes.md");
  await clickMenuItem("Discard changes...");
  await vi.waitFor(() =>
    expect(state.confirm).toHaveBeenCalledWith(
      'Discard changes to "app/notes.md"? Untracked files will be deleted. This cannot be undone.',
      { variant: "destructive" },
    ),
  );
  expect(state.discard).not.toHaveBeenCalled();

  state.confirm.mockResolvedValueOnce(true);
  await openMenu("unstaged", "app/notes.md");
  await clickMenuItem("Discard changes...");
  await vi.waitFor(() => expect(state.discard).toHaveBeenCalledWith(pathsInput(["app/notes.md"])));
});

it("copies and mentions every selected path, relative to the project when inside it", async () => {
  await using _screen = await setup();
  using _menu = { [Symbol.dispose]: () => dismissContextMenu() };
  using clipboard = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);

  await userEvent.click(row("unstaged", "app/notes.md"));
  await userEvent.click(row("unstaged", "README.md"), { modifiers: ["ControlOrMeta"] });

  await openMenu("unstaged", "README.md");
  await clickMenuItem("Copy paths");
  await vi.waitFor(() => expect(clipboard).toHaveBeenCalledWith("app/notes.md\nREADME.md"));
  dismissContextMenu();
  clipboard.mockClear();
  row("unstaged", "README.md").focus();
  await userEvent.keyboard("{ControlOrMeta>}c{/ControlOrMeta}");
  await vi.waitFor(() => expect(clipboard).toHaveBeenCalledWith("app/notes.md\nREADME.md"));

  await openMenu("unstaged", "README.md");
  await clickMenuItem("Add to chat");
  await vi.waitFor(() =>
    expect(state.insertTextAtEnd).toHaveBeenCalledWith(
      "[notes.md](notes.md) [README.md](/repo/README.md) ",
      { ensureLeadingBoundary: true },
    ),
  );
});

it("commits only staged changes and blocks the commit while conflicts remain", async () => {
  await using screen = await setup();
  await userEvent.click(page.getByRole("button", { name: "Commit", exact: true }));
  expect(state.commit).toHaveBeenCalledWith(
    expect.objectContaining({ action: "commit", stagedOnly: true }),
  );
  await expect
    .element(page.getByRole("button", { name: "More commit actions" }))
    .not.toBeInTheDocument();

  state.staging = { ...state.staging, unstaged: [file("app/conflict.ts", "conflicted")] };
  await screen.rerender(
    <ComposerHandleContext value={null}>
      <StagingPanel
        composerDraftTarget={COMPOSER_TARGET}
        environmentId={ENVIRONMENT_ID}
        cwd={CWD}
        repositoryRoot="/repo"
        visible
      />
    </ComposerHandleContext>,
  );
  await expect
    .element(page.getByRole("button", { name: "Commit", exact: true }))
    .toHaveAccessibleDescription("Resolve merge conflicts first.");
  await expect.element(page.getByRole("button", { name: "Commit", exact: true })).toBeDisabled();
});

it.each([
  ["Commit & push", "commit_push"],
  ["Commit, push & create PR", "commit_push_pr"],
])("runs %s with only staged files", async (label, action) => {
  await using _screen = await setup({}, { hasPrimaryRemote: true });
  await userEvent.click(page.getByRole("button", { name: "More commit actions" }));
  await clickMenuItem(label);
  expect(state.commit).toHaveBeenCalledWith(expect.objectContaining({ action, stagedOnly: true }));
});

it.each([
  ["Push", "push"],
  ["Create PR", "create_pr"],
])("allows %s without staged files and never commits unstaged edits", async (label, action) => {
  await using _screen = await setup(
    { staged: [] },
    { hasPrimaryRemote: true, aheadCount: 1, aheadOfDefaultCount: 1 },
  );
  await expect.element(page.getByRole("button", { name: "Commit", exact: true })).toBeDisabled();
  await userEvent.click(page.getByRole("button", { name: "More commit actions" }));
  await clickMenuItem(label);
  expect(state.commit).toHaveBeenCalledWith(expect.objectContaining({ action }));
  expect(state.commit.mock.calls[0]![0]).not.toHaveProperty("stagedOnly");
});

it("requires confirmation before publishing staged changes to the default branch", async () => {
  await using _screen = await setup(
    {},
    { hasPrimaryRemote: true, isDefaultRef: true, refName: "main" },
  );
  state.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  await userEvent.click(page.getByRole("button", { name: "More commit actions" }));
  await expect
    .element(page.getByRole("menuitem", { name: /Commit, push & create PR/ }))
    .toBeDisabled();
  await clickMenuItem("Commit & push");
  expect(state.confirm).toHaveBeenCalledWith(expect.stringContaining('default branch "main"'));
  expect(state.commit).not.toHaveBeenCalled();
  await userEvent.click(page.getByRole("button", { name: "More commit actions" }));
  await clickMenuItem("Commit & push");
  expect(state.commit).toHaveBeenCalledWith(
    expect.objectContaining({ action: "commit_push", stagedOnly: true }),
  );
});

it.each([{ refName: null }, { behindCount: 1 }])(
  "blocks publishing for an unavailable branch: %j",
  async (status) => {
    await using _screen = await setup({}, { hasPrimaryRemote: true, ...status });
    await userEvent.click(page.getByRole("button", { name: "More commit actions" }));
    await expect.element(page.getByRole("menuitem", { name: /Commit & push/ })).toBeDisabled();
    await expect
      .element(page.getByRole("menuitem", { name: /Commit, push & create PR/ }))
      .toBeDisabled();
    expect(state.commit).not.toHaveBeenCalled();
  },
);

it("updates an existing PR by pushing, and uses MR terminology for GitLab", async () => {
  await using screen = await setup(
    {},
    {
      hasPrimaryRemote: true,
      sourceControlProvider: {
        kind: SourceControlProviderKind.make("gitlab"),
        name: "GitLab",
        baseUrl: "https://gitlab.com",
      },
    },
  );
  await userEvent.click(page.getByRole("button", { name: "More commit actions" }));
  await clickMenuItem("Commit, push & create MR");
  expect(state.commit).toHaveBeenCalledWith(
    expect.objectContaining({ action: "commit_push_pr", stagedOnly: true }),
  );
  state.status = {
    ...state.status,
    pr: {
      number: 1,
      title: "Existing",
      url: "https://gitlab.com/example/project/-/merge_requests/1",
      baseRef: "main",
      headRef: "feature/staging",
      state: "open",
    },
  };
  await screen.rerender(
    <ComposerHandleContext value={null}>
      <StagingPanel
        composerDraftTarget={COMPOSER_TARGET}
        environmentId={ENVIRONMENT_ID}
        cwd={CWD}
        repositoryRoot="/repo"
        visible
      />
    </ComposerHandleContext>,
  );
  await userEvent.click(page.getByRole("button", { name: "More commit actions" }));
  await expect
    .element(page.getByRole("menuitem", { name: "Commit & push", exact: true }))
    .toBeVisible();
  await expect.element(page.getByRole("menuitem", { name: /create MR/ })).not.toBeInTheDocument();
});

it("reports a push failure separately from committing", async () => {
  await using _screen = await setup({}, { hasPrimaryRemote: true });
  using toast = vi.spyOn(toastManager, "add");
  state.commit.mockResolvedValueOnce({
    _tag: "Failure",
    cause: Cause.fail(
      new VcsActionRemoteFailureError({
        actionId: "action",
        transportActionId: "transport",
        action: "commit_push",
        environmentId: ENVIRONMENT_ID,
        cwd: CWD,
        phase: "push",
        remoteMessageLength: 0,
      }),
    ),
  });
  await userEvent.click(page.getByRole("button", { name: "More commit actions" }));
  await clickMenuItem("Commit & push");
  expect(toast).toHaveBeenCalledWith(
    expect.objectContaining({ type: "error", title: "Push failed" }),
  );
  expect(state.refresh).toHaveBeenCalledWith({
    environmentId: ENVIRONMENT_ID,
    input: { cwd: CWD },
  });
});

it("reflects a Git action started elsewhere and blocks another action", async () => {
  await using _screen = await setup(
    {},
    { hasPrimaryRemote: true },
    { isRunning: true, currentLabel: "Pushing..." },
  );
  await expect.element(page.getByRole("button", { name: "Pushing..." })).toBeDisabled();
  await expect.element(page.getByRole("button", { name: "More commit actions" })).toBeDisabled();
  document.querySelector<HTMLButtonElement>('[aria-label="Commit actions"] button')!.click();
  expect(state.commit).not.toHaveBeenCalled();
});

it("blocks commit and publish choices when source control permission is absent", async () => {
  await using screen = await setup({}, { hasPrimaryRemote: true });
  state.allowed = false;
  await screen.rerender(
    <ComposerHandleContext value={null}>
      <StagingPanel
        composerDraftTarget={COMPOSER_TARGET}
        environmentId={ENVIRONMENT_ID}
        cwd={CWD}
        repositoryRoot="/repo"
        visible
      />
    </ComposerHandleContext>,
  );
  await expect.element(page.getByRole("button", { name: "Commit", exact: true })).toBeDisabled();
  await userEvent.click(page.getByRole("button", { name: "More commit actions" }));
  for (const index of [0, 1, 2]) {
    await expect.element(page.getByRole("menuitem").nth(index)).toBeDisabled();
  }
  expect(state.commit).not.toHaveBeenCalled();
});

it.each([
  ["unstaged", "app/src/main.ts", "Unstaged changes"],
  ["staged", "app/lib/new.ts", "Staged changes"],
] as const)("adds %s diff comments to the existing composer draft", async (list, path, title) => {
  await using _screen = await setup();
  await userEvent.click(page.getByRole("button", { name: "Filter files" }));
  const filterInput = page.getByRole("searchbox", { name: "Filter changed files" });
  await userEvent.fill(filterInput, "app");
  await userEvent.click(row(list, path));
  await userEvent.click(page.getByRole("button", { name: `Comment on ${path}` }));
  const editor = page.getByPlaceholder("Add a comment…");
  await userEvent.fill(editor, "Cancel this draft");
  await userEvent.keyboard("{Escape}");
  await expect.element(editor).not.toBeInTheDocument();
  await expect.element(filterInput).toHaveValue("app");
  expect(row("unstaged", "README.md")).toBeNull();
  await userEvent.click(page.getByRole("button", { name: `Comment on ${path}` }));
  await userEvent.fill(editor, "Review this change");
  await userEvent.keyboard("{ControlOrMeta>}{Enter}{/ControlOrMeta}");
  await vi.waitFor(() =>
    expect(
      useComposerDraftStore.getState().getComposerDraft(COMPOSER_TARGET)?.reviewComments,
    ).toEqual([
      expect.objectContaining({
        filePath: path,
        sectionTitle: title,
        sectionId: `staging:${list}`,
        text: "Review this change",
        rangeLabel: "+1",
        diff: expect.stringContaining("+new value"),
      }),
    ]),
  );
  await expect.element(editor).not.toBeInTheDocument();
  for (const from of [list, list === "staged" ? "unstaged" : "staged"] as const) {
    const to = from === "staged" ? "unstaged" : "staged";
    const command = from === "staged" ? state.unstage : state.stage;
    command.mockImplementationOnce(async () => {
      const moved = state.staging[from].find((entry) => entry.path === path)!;
      state.staging = {
        ...state.staging,
        [from]: state.staging[from].filter((entry) => entry.path !== path),
        [to]: [...state.staging[to], moved],
      };
      return SUCCESS;
    });
    await userEvent.click(
      page.getByRole("button", { name: from === "staged" ? "Unstage" : "Stage", exact: true }),
    );
    await userEvent.click(row(to, path));
    await expect.element(page.getByText("Review this change", { exact: true })).toBeVisible();
    expect(
      useComposerDraftStore.getState().getComposerDraft(COMPOSER_TARGET)?.reviewComments,
    ).toHaveLength(1);
    if (to !== list) {
      state.contents = { ...state.contents, newContents: "a different change\n" };
      await userEvent.fill(filterInput, "app/");
      await expect
        .element(page.getByText("Review this change", { exact: true }))
        .not.toBeInTheDocument();
      state.contents = { ...state.contents, newContents: "new value\n" };
      await userEvent.fill(filterInput, "app");
      await expect.element(page.getByText("Review this change", { exact: true })).toBeVisible();
    }
  }
  await userEvent.click(page.getByRole("button", { name: "Delete comment" }));
  expect(
    useComposerDraftStore.getState().getComposerDraft(COMPOSER_TARGET)?.reviewComments ?? [],
  ).toEqual([]);
  expect(state.commit).not.toHaveBeenCalled();
});

it("resizes the file lists and their split by dragging, and resets on double-click", async () => {
  await using _screen = await setup();
  const aside = document.querySelector<HTMLElement>("[data-staging-panel] aside")!;
  const panel = document
    .querySelector<HTMLElement>("[data-staging-panel]")!
    .getBoundingClientRect();
  const separator = (name: string) =>
    document.querySelector<HTMLElement>(`[role="separator"][aria-label="${name}"]`)!;
  const drag = (handle: HTMLElement, clientX: number, clientY: number, release = "pointerup") => {
    const pointer = { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX, clientY };
    handle.dispatchEvent(new PointerEvent("pointerdown", pointer));
    handle.dispatchEvent(new PointerEvent("pointermove", pointer));
    handle.dispatchEvent(new PointerEvent(release, pointer));
  };
  const height = (label: string) =>
    document.querySelector(`section[aria-label="${label}"]`)!.getBoundingClientRect().height;

  drag(separator("Resize file lists"), panel.right - 500, panel.top + 10);
  await vi.waitFor(() => expect(aside.getBoundingClientRect().width).toBe(500));
  expect(localStorage.getItem("t3code:staging-lists-width")).toBe("500");

  // An interrupted drag snaps back instead of saving where it stopped.
  drag(separator("Resize file lists"), panel.right - 400, panel.top + 10, "pointercancel");
  expect(aside.getBoundingClientRect().width).toBe(500);
  expect(localStorage.getItem("t3code:staging-lists-width")).toBe("500");

  // Past the bottom edge clamps, so neither list can disappear.
  drag(separator("Resize staged and unstaged lists"), panel.right - 10, panel.bottom + 100);
  expect(localStorage.getItem("t3code:staging-list-split")).toBe("0.9");
  expect(height("Staged changes")).toBeGreaterThan(0);
  expect(height("Unstaged changes")).toBeGreaterThan(height("Staged changes") * 4);

  await userEvent.dblClick(separator("Resize file lists"));
  await userEvent.dblClick(separator("Resize staged and unstaged lists"));
  await vi.waitFor(() => expect(aside.getBoundingClientRect().width).toBe(320));
  expect(Math.abs(height("Unstaged changes") - height("Staged changes"))).toBeLessThan(2);
});
