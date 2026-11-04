import {
  EnvironmentId,
  type VcsStagingFile,
  type VcsStagingStatusResult,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  staging: null as unknown as VcsStagingStatusResult,
  stage: vi.fn(),
  unstage: vi.fn(),
  discard: vi.fn(),
  commit: vi.fn(),
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
    vcsEnvironment: {
      ...actual.vcsEnvironment,
      stagingStatus: (() => "staging-status") as never,
      stagingFileContents: (() => "file-contents") as never,
      stagePaths: command(state.stage) as never,
      unstagePaths: command(state.unstage) as never,
      discardPaths: command(state.discard) as never,
    },
  };
});
vi.mock(import("~/state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuery: ((atom: unknown) =>
    atom === "staging-status" ? { data: state.staging } : { data: undefined }) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: ((command: { run: unknown }) => command.run) as never,
}));
vi.mock(import("~/state/sourceControlActions"), async (importOriginal) => ({
  ...(await importOriginal()),
  useGitStackedAction: (() => ({
    run: state.commit,
    isAllowed: true,
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

import { ComposerHandleContext } from "~/composerHandleContext";
import { dismissContextMenu } from "~/contextMenuFallback";
import { render } from "../../../test/render";
import { StagingPanel } from "./StagingPanel";

const ENVIRONMENT_ID = EnvironmentId.make("env-staging");
// The project is a subfolder of the repository, so status paths start with "app/".
const CWD = "/repo/app";
const SUCCESS = { _tag: "Success", value: undefined };

const file = (
  path: string,
  change: VcsStagingFile["change"],
  previousPath: string | null = null,
): VcsStagingFile => ({ path, change, previousPath }) as VcsStagingFile;

function setup(overrides: Partial<VcsStagingStatusResult> = {}) {
  localStorage.removeItem("t3code:staging-view");
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
  for (const command of [state.stage, state.unstage, state.discard]) {
    command.mockReset().mockResolvedValue(SUCCESS);
  }
  state.commit
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { toast: { title: "Ok" } } });
  state.confirm.mockReset();
  state.openFile.mockReset().mockResolvedValue(undefined);
  state.insertTextAtEnd.mockReset().mockReturnValue(true);
  const composer = { current: { insertTextAtEnd: state.insertTextAtEnd } } as never;
  return render(
    <ComposerHandleContext value={composer}>
      <StagingPanel environmentId={ENVIRONMENT_ID} cwd={CWD} repositoryRoot="/repo" visible />
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

  await userEvent.dblClick(row("unstaged", "app/notes.md"));
  expect(state.stage).toHaveBeenCalledWith(pathsInput(["app/notes.md"]));

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

  state.staging = { ...state.staging, unstaged: [file("app/conflict.ts", "conflicted")] };
  await screen.rerender(
    <ComposerHandleContext value={null}>
      <StagingPanel environmentId={ENVIRONMENT_ID} cwd={CWD} repositoryRoot="/repo" visible />
    </ComposerHandleContext>,
  );
  await expect
    .element(page.getByRole("button", { name: "Commit", exact: true }))
    .toHaveAttribute("title", "Resolve merge conflicts first.");
  await expect.element(page.getByRole("button", { name: "Commit", exact: true })).toBeDisabled();
});
