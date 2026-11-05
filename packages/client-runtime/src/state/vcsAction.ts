import {
  EnvironmentId,
  type EnvironmentId as EnvironmentIdType,
  GitActionProgressPhase,
  type GitActionProgressEvent,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  GitStackedAction,
  type ThreadId,
  type ProjectId,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as Persistence from "../platform/persistence.ts";
import { runStreamGuarded, RpcPermissionGuard } from "../rpc/client.ts";
import {
  createRuntimeCommand,
  runStreamInEnvironment,
  type AtomCommand,
  type AtomCommandResult,
} from "./runtime.ts";
import { createCommandPermissions } from "./commandPermissions.ts";
import { vcsCommandScheduler } from "./vcsCommandScheduler.ts";
import { invalidateCachedVcsRefs } from "./vcsRefInvalidation.ts";

export const VcsActionOperation = Schema.Literals([
  "refresh_status",
  "run_change_request",
  "pull",
  "switch_ref",
  "create_ref",
  "create_worktree",
  "init",
  "publish_repository",
  "prepare_pull_request_thread",
]);
export type VcsActionOperation = typeof VcsActionOperation.Type;

export interface VcsActionState {
  readonly isRunning: boolean;
  readonly operation: VcsActionOperation | null;
  readonly actionId: string | null;
  readonly action: GitStackedAction | null;
  readonly currentLabel: string | null;
  readonly currentPhaseLabel: string | null;
  readonly hookName: string | null;
  readonly lastOutputLine: string | null;
  readonly phaseStartedAtMs: number | null;
  readonly hookStartedAtMs: number | null;
  /** Resolved message of the commit being attempted, kept so a rejected commit can be retried. */
  readonly commitMessage: string | null;
  /** Display-safe tail of hook output streamed during this action. Memory only, never persisted. */
  readonly hookTranscript: VcsHookTranscript;
  readonly error: string | null;
}

/** Bounded, sanitized hook output. `droppedLines` counts older lines evicted to stay in bounds. */
export interface VcsHookTranscript {
  readonly lines: ReadonlyArray<string>;
  readonly chars: number;
  readonly droppedLines: number;
}

/** Context needed to retry a commit a hook rejected, against the target it originally ran on. */
export interface VcsHookFailure {
  readonly target: ResolvedVcsActionTarget;
  readonly actionId: string;
  readonly action: GitStackedAction;
  readonly hookName: string;
  readonly exitCode: number;
  readonly transcript: VcsHookTranscript;
  /** True when `git commit --no-verify` skips the failing hook (pre-commit and commit-msg). */
  readonly canSkipVerification: boolean;
  readonly commitMessage: string | null;
  readonly filePaths: readonly string[] | null;
  readonly threadId: ThreadId | null;
  readonly projectId: ProjectId | null;
  readonly pendingRetry: { readonly actionId: string; readonly noVerify: boolean } | null;
}

export interface RetryVcsHookFailureInput {
  readonly actionId: string;
  /** Skips pre-commit and commit-msg for this attempt only. */
  readonly noVerify: boolean;
}

export interface VcsActionTarget {
  readonly environmentId: EnvironmentIdType | null;
  readonly cwd: string | null;
}

export interface ResolvedVcsActionTarget {
  readonly environmentId: EnvironmentIdType;
  readonly cwd: string;
}

export interface BeginVcsActionInput {
  readonly operation: VcsActionOperation;
  readonly label: string;
  readonly actionId?: string;
}

export interface RunVcsStackedActionInput {
  readonly actionId: string;
  readonly action: GitStackedAction;
  readonly commitMessage?: string;
  readonly featureBranch?: boolean;
  readonly filePaths?: ReadonlyArray<string>;
  readonly noVerify?: boolean;
  readonly threadId?: ThreadId;
  readonly projectId?: ProjectId;
  readonly onProgress?: (event: GitActionProgressEvent) => void;
}

export class VcsActionUnavailableError extends Schema.TaggedError<VcsActionUnavailableError>()(
  "VcsActionUnavailableError",
  {
    operation: VcsActionOperation,
    environmentId: Schema.NullOr(EnvironmentId),
    cwd: Schema.NullOr(Schema.String),
  },
) {
  override get message(): string {
    return `Source control operation '${this.operation.replaceAll("_", " ")}' is unavailable.`;
  }
}

export class VcsActionRemoteFailureError extends Schema.TaggedError<VcsActionRemoteFailureError>()(
  "VcsActionRemoteFailureError",
  {
    actionId: Schema.String,
    transportActionId: Schema.String,
    action: GitStackedAction,
    environmentId: EnvironmentId,
    cwd: Schema.String,
    phase: Schema.NullOr(GitActionProgressPhase),
    remoteMessageLength: Schema.Number,
  },
) {
  override get message(): string {
    const phase = this.phase === null ? "execution" : this.phase;
    return `Source control action '${this.action}' failed during ${phase}.`;
  }
}

/** A commit hook exited non-zero and git refused the commit. Carries no hook output. */
export class VcsActionHookRejectedError extends Schema.TaggedError<VcsActionHookRejectedError>()(
  "VcsActionHookRejectedError",
  {
    actionId: Schema.String,
    transportActionId: Schema.String,
    action: GitStackedAction,
    environmentId: EnvironmentId,
    cwd: Schema.String,
    hookName: Schema.String,
    exitCode: Schema.Int,
  },
) {
  override get message(): string {
    return `The ${this.hookName} hook rejected the commit (exit code ${this.exitCode}).`;
  }
}

/** Schema-aware guard for surfaces that report hook rejections through the hook failure UI. */
export const isVcsActionHookRejectedError = Schema.is(VcsActionHookRejectedError);

export class VcsActionMissingTerminalEventError extends Schema.TaggedError<VcsActionMissingTerminalEventError>()(
  "VcsActionMissingTerminalEventError",
  {
    actionId: Schema.String,
    transportActionId: Schema.String,
    action: GitStackedAction,
    environmentId: EnvironmentId,
    cwd: Schema.String,
  },
) {
  override get message(): string {
    return `Source control action '${this.action}' ended without a terminal result.`;
  }
}

export class VcsActionTargetKeyParseError extends Schema.TaggedError<VcsActionTargetKeyParseError>()(
  "VcsActionTargetKeyParseError",
  {
    keyLength: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Invalid source control action target key (${this.keyLength} characters).`;
  }
}

export const VcsActionExecutionError = Schema.Union([
  VcsActionRemoteFailureError,
  VcsActionHookRejectedError,
  VcsActionMissingTerminalEventError,
]);
export type VcsActionExecutionError = typeof VcsActionExecutionError.Type;

export const EMPTY_VCS_HOOK_TRANSCRIPT = Object.freeze<VcsHookTranscript>({
  lines: [],
  chars: 0,
  droppedLines: 0,
});

export const EMPTY_VCS_ACTION_STATE = Object.freeze<VcsActionState>({
  isRunning: false,
  operation: null,
  actionId: null,
  action: null,
  currentLabel: null,
  currentPhaseLabel: null,
  hookName: null,
  lastOutputLine: null,
  phaseStartedAtMs: null,
  hookStartedAtMs: null,
  commitMessage: null,
  hookTranscript: EMPTY_VCS_HOOK_TRANSCRIPT,
  error: null,
});

export const VCS_HOOK_TRANSCRIPT_MAX_LINES = 200;
export const VCS_HOOK_TRANSCRIPT_MAX_CHARS = 32 * 1024;
const COMMIT_GATING_HOOKS = new Set(["pre-commit", "prepare-commit-msg", "commit-msg"]);
const NO_VERIFY_HOOKS = new Set(["pre-commit", "commit-msg"]);
// CSI and OSC escape sequences, then any remaining C0/C1 controls except tab.
const TERMINAL_CONTROL_PATTERN =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-_]?|[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** Strips ANSI escapes and terminal control characters so hook output renders as plain text. */
function sanitizeVcsHookOutput(text: string): string {
  return text.replace(TERMINAL_CONTROL_PATTERN, "").trimEnd();
}

/** Appends one output line, evicting the oldest lines past the line and character bounds. */
export function appendVcsHookTranscript(
  transcript: VcsHookTranscript,
  text: string,
): VcsHookTranscript {
  const line = sanitizeVcsHookOutput(text).slice(0, VCS_HOOK_TRANSCRIPT_MAX_CHARS);
  if (line.length === 0) {
    return transcript;
  }
  const lines = [...transcript.lines, line];
  let chars = transcript.chars + line.length;
  let dropped = 0;
  while (
    lines.length - dropped > VCS_HOOK_TRANSCRIPT_MAX_LINES ||
    chars > VCS_HOOK_TRANSCRIPT_MAX_CHARS
  ) {
    chars -= lines[dropped]!.length;
    dropped += 1;
  }
  return {
    lines: dropped === 0 ? lines : lines.slice(dropped),
    chars,
    droppedLines: transcript.droppedLines + dropped,
  };
}

const nowMs = (): number => DateTime.toEpochMillis(DateTime.nowUnsafe());
let nextLocalActionId = 0;
const decodeVcsActionTargetKey = Schema.decodeUnknownSync(
  Schema.Tuple([EnvironmentId, Schema.String]),
);

const vcsActionStateAtom = Atom.family((key: string) => {
  return Atom.make(EMPTY_VCS_ACTION_STATE).pipe(
    Atom.keepAlive,
    Atom.withLabel(`vcs-action:${key}`),
  );
});

const EMPTY_VCS_ACTION_ATOM = Atom.make(EMPTY_VCS_ACTION_STATE).pipe(
  Atom.keepAlive,
  Atom.withLabel("vcs-action:null"),
);

function getVcsActionTargetKey(target: VcsActionTarget): string | null {
  if (target.environmentId === null || target.cwd === null) {
    return null;
  }
  return JSON.stringify([target.environmentId, target.cwd]);
}

export function parseVcsActionTargetKey(key: string): ResolvedVcsActionTarget {
  try {
    const [environmentId, cwd] = decodeVcsActionTargetKey(JSON.parse(key));
    return { environmentId, cwd };
  } catch (cause) {
    throw new VcsActionTargetKeyParseError({ keyLength: key.length, cause });
  }
}

function getVcsActionStateAtom(target: VcsActionTarget) {
  const key = getVcsActionTargetKey(target);
  return key === null ? EMPTY_VCS_ACTION_ATOM : vcsActionStateAtom(key);
}

function createLocalActionId(): string {
  nextLocalActionId += 1;
  return `local-vcs-action:${nextLocalActionId}`;
}

export function beginVcsActionState(
  input: BeginVcsActionInput,
): VcsActionState & { readonly actionId: string } {
  const actionId = input.actionId ?? createLocalActionId();
  const startedAt = nowMs();
  return {
    ...EMPTY_VCS_ACTION_STATE,
    isRunning: true,
    operation: input.operation,
    actionId,
    currentLabel: input.label,
    currentPhaseLabel: input.label,
    phaseStartedAtMs: startedAt,
  };
}

function failVcsActionState(
  operation: VcsActionOperation,
  actionId: string,
  error: unknown,
): VcsActionState {
  return {
    ...EMPTY_VCS_ACTION_STATE,
    operation,
    actionId,
    error: error instanceof Error ? error.message : "Source control action failed.",
  };
}

export function createVcsActionTransportId(
  target: ResolvedVcsActionTarget,
  actionId: string,
): string {
  const targetKey = JSON.stringify([target.environmentId, target.cwd]);
  return `${targetKey.length}:${targetKey}${actionId}`;
}

export function normalizeVcsActionProgressEvent(
  target: ResolvedVcsActionTarget,
  transportActionId: string,
  actionId: string,
  event: GitActionProgressEvent,
): GitActionProgressEvent | null {
  if (event.actionId !== transportActionId || event.cwd !== target.cwd) {
    return null;
  }
  return {
    ...event,
    actionId,
  };
}

export function consumeVcsActionProgress<E, R>(
  stream: Stream.Stream<GitActionProgressEvent, E, R>,
  input: {
    readonly target: ResolvedVcsActionTarget;
    readonly transportActionId: string;
    readonly actionId: string;
    readonly action: GitStackedAction;
    readonly onProgress: (event: GitActionProgressEvent) => Effect.Effect<void>;
  },
): Effect.Effect<GitRunStackedActionResult, E | VcsActionExecutionError, R> {
  return Effect.suspend(() => {
    let terminalEvent: GitActionProgressEvent | null = null;
    let rejectingHook: { readonly hookName: string; readonly exitCode: number } | null = null;
    return stream.pipe(
      Stream.runForEach((event) => {
        const normalized = normalizeVcsActionProgressEvent(
          input.target,
          input.transportActionId,
          input.actionId,
          event,
        );
        if (normalized === null) {
          return Effect.void;
        }
        if (normalized.kind === "action_finished" || normalized.kind === "action_failed") {
          terminalEvent = normalized;
        } else if (normalized.kind === "phase_started") {
          rejectingHook = null;
        } else if (
          normalized.kind === "hook_finished" &&
          normalized.exitCode !== null &&
          normalized.exitCode !== 0 &&
          COMMIT_GATING_HOOKS.has(normalized.hookName)
        ) {
          rejectingHook = { hookName: normalized.hookName, exitCode: normalized.exitCode };
        }
        return input.onProgress(normalized);
      }),
      // The RPC stream fails with the Git error after delivering its terminal failure event.
      Effect.catch((error) =>
        terminalEvent?.kind === "action_failed" ? Effect.void : Effect.fail(error),
      ),
      Effect.flatMap(() => {
        if (terminalEvent?.kind === "action_finished") {
          return Effect.succeed(terminalEvent.result);
        }
        if (
          terminalEvent?.kind === "action_failed" &&
          terminalEvent.phase === "commit" &&
          rejectingHook !== null
        ) {
          return Effect.fail<VcsActionExecutionError>(
            new VcsActionHookRejectedError({
              actionId: input.actionId,
              transportActionId: input.transportActionId,
              action: terminalEvent.action,
              environmentId: input.target.environmentId,
              cwd: input.target.cwd,
              hookName: rejectingHook.hookName,
              exitCode: rejectingHook.exitCode,
            }),
          );
        }
        if (terminalEvent?.kind === "action_failed") {
          return Effect.fail<VcsActionExecutionError>(
            new VcsActionRemoteFailureError({
              actionId: input.actionId,
              transportActionId: input.transportActionId,
              action: terminalEvent.action,
              environmentId: input.target.environmentId,
              cwd: input.target.cwd,
              phase: terminalEvent.phase,
              remoteMessageLength: terminalEvent.message.length,
            }),
          );
        }
        return Effect.fail<VcsActionExecutionError>(
          new VcsActionMissingTerminalEventError({
            actionId: input.actionId,
            transportActionId: input.transportActionId,
            action: input.action,
            environmentId: input.target.environmentId,
            cwd: input.target.cwd,
          }),
        );
      }),
    );
  });
}

export function applyVcsActionProgressEvent(
  current: VcsActionState,
  event: GitActionProgressEvent,
): VcsActionState {
  if (current.actionId !== event.actionId) {
    return current;
  }
  const now = nowMs();

  switch (event.kind) {
    case "action_started":
      return {
        ...current,
        isRunning: true,
        actionId: event.actionId,
        action: event.action,
        operation: "run_change_request",
        phaseStartedAtMs: now,
        hookStartedAtMs: null,
        hookName: null,
        lastOutputLine: null,
        error: null,
      };
    case "phase_started":
      return {
        ...current,
        isRunning: true,
        actionId: event.actionId,
        action: event.action,
        operation: "run_change_request",
        currentLabel: event.label,
        currentPhaseLabel: event.label,
        phaseStartedAtMs: now,
        hookStartedAtMs: null,
        hookName: null,
        lastOutputLine: null,
        ...(event.commitMessage !== undefined ? { commitMessage: event.commitMessage } : {}),
        hookTranscript: EMPTY_VCS_HOOK_TRANSCRIPT,
        error: null,
      };
    case "hook_started":
      return {
        ...current,
        isRunning: true,
        actionId: event.actionId,
        action: event.action,
        operation: "run_change_request",
        currentLabel: `Running ${event.hookName}...`,
        hookName: event.hookName,
        hookStartedAtMs: now,
        lastOutputLine: null,
        error: null,
      };
    case "hook_output":
      return {
        ...current,
        isRunning: true,
        actionId: event.actionId,
        action: event.action,
        operation: "run_change_request",
        lastOutputLine: event.text,
        hookTranscript: appendVcsHookTranscript(current.hookTranscript, event.text),
        error: null,
      };
    case "hook_finished":
      return {
        ...current,
        isRunning: true,
        actionId: event.actionId,
        action: event.action,
        operation: "run_change_request",
        currentLabel: current.currentPhaseLabel,
        hookName: null,
        hookStartedAtMs: null,
        lastOutputLine: null,
        error: null,
      };
    case "action_finished":
      return {
        ...current,
        isRunning: true,
        actionId: event.actionId,
        action: event.action,
        operation: "run_change_request",
        error: null,
      };
    case "action_failed":
      return {
        ...current,
        isRunning: true,
        actionId: event.actionId,
        action: event.action,
        operation: "run_change_request",
        error: event.message,
      };
  }
}

export function createVcsActionManager<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Persistence.EnvironmentCacheStore | R, E>,
) {
  // One rejected commit is surfaced at a time; it keeps its own target so switching projects or
  // environments never retargets the retry.
  const hookFailureAtom = Atom.make<VcsHookFailure | null>(null).pipe(
    Atom.keepAlive,
    Atom.withLabel("vcs-action:hook-failure"),
  );
  const runStackedActionCommands = new Map<
    string,
    AtomCommand<RunVcsStackedActionInput, GitRunStackedActionResult, unknown>
  >();
  const getRunStackedActionCommand = (requestedTarget: VcsActionTarget) => {
    const targetKey = getVcsActionTargetKey(requestedTarget);
    const commandKey =
      targetKey ??
      JSON.stringify([
        "vcs-action-target:unavailable",
        requestedTarget.environmentId,
        requestedTarget.cwd,
      ]);
    const existing = runStackedActionCommands.get(commandKey);
    if (existing !== undefined) {
      return existing;
    }
    const target = targetKey === null ? null : parseVcsActionTargetKey(targetKey);
    const stateAtom = targetKey === null ? EMPTY_VCS_ACTION_ATOM : vcsActionStateAtom(targetKey);
    const command = createRuntimeCommand<
      EnvironmentRegistry | Persistence.EnvironmentCacheStore | R,
      E,
      RunVcsStackedActionInput,
      GitRunStackedActionResult,
      unknown
    >(runtime, {
      label: `vcs-action:run-stacked:${commandKey}`,
      scheduler: vcsCommandScheduler,
      concurrency: { mode: "serial", key: () => commandKey },
      execute: Effect.fn("VcsAction.runStackedAction")(function* (
        input: RunVcsStackedActionInput,
        registry,
      ) {
        if (target === null) {
          return yield* new VcsActionUnavailableError({
            operation: "run_change_request",
            environmentId: requestedTarget.environmentId,
            cwd: requestedTarget.cwd,
          });
        }
        const transportActionId = createVcsActionTransportId(target, input.actionId);
        const ownsHookFailure = () => {
          const failure = registry.get(hookFailureAtom);
          return failure !== null && failure.pendingRetry?.actionId === input.actionId;
        };
        const priorFailure = registry.get(hookFailureAtom);
        if (
          priorFailure !== null &&
          !ownsHookFailure() &&
          getVcsActionTargetKey(priorFailure.target) === targetKey
        ) {
          registry.set(hookFailureAtom, null);
        }
        registry.set(
          stateAtom,
          beginVcsActionState({
            operation: "run_change_request",
            label: "Running source control action",
            actionId: input.actionId,
          }),
        );

        const rpcInput: GitRunStackedActionInput = {
          actionId: transportActionId,
          cwd: target.cwd,
          action: input.action,
          ...(input.commitMessage ? { commitMessage: input.commitMessage } : {}),
          ...(input.featureBranch ? { featureBranch: true } : {}),
          ...(input.filePaths?.length ? { filePaths: [...input.filePaths] } : {}),
          ...(input.noVerify ? { noVerify: true } : {}),
          ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
          ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
        };
        const clearOwnedState = Effect.sync(() => {
          const current = registry.get(stateAtom);
          if (current.actionId === input.actionId) {
            registry.set(stateAtom, EMPTY_VCS_ACTION_STATE);
          }
        });
        return yield* consumeVcsActionProgress(
          runStreamInEnvironment(
            target.environmentId,
            runStreamGuarded(WS_METHODS.gitRunStackedAction, rpcInput),
          ),
          {
            target,
            transportActionId,
            actionId: input.actionId,
            action: input.action,
            onProgress: (event) =>
              Effect.sync(() => {
                const current = registry.get(stateAtom);
                if (current.actionId !== input.actionId) {
                  return;
                }
                registry.set(stateAtom, applyVcsActionProgressEvent(current, event));
                if (input.onProgress !== undefined) {
                  try {
                    input.onProgress(event);
                  } catch {}
                }
              }),
          },
        ).pipe(
          Effect.provideService(RpcPermissionGuard, {
            authorize: (id, method, payload) =>
              createCommandPermissions(runtime, method).authorize(registry, id, payload),
          }),
          Effect.ensuring(invalidateCachedVcsRefs(registry, target)),
          Effect.tap(() =>
            Effect.sync(() => {
              if (ownsHookFailure()) registry.set(hookFailureAtom, null);
            }),
          ),
          Effect.tap(() => clearOwnedState),
          Effect.tapError((error) =>
            Effect.sync(() => {
              const current = registry.get(stateAtom);
              if (isVcsActionHookRejectedError(error)) {
                const owned = current.actionId === input.actionId;
                registry.set(hookFailureAtom, {
                  target,
                  actionId: input.actionId,
                  action: input.action,
                  hookName: error.hookName,
                  exitCode: error.exitCode,
                  transcript: owned ? current.hookTranscript : EMPTY_VCS_HOOK_TRANSCRIPT,
                  canSkipVerification: NO_VERIFY_HOOKS.has(error.hookName),
                  commitMessage:
                    (owned ? current.commitMessage : null) ?? input.commitMessage ?? null,
                  filePaths: input.filePaths?.length ? input.filePaths : null,
                  threadId: input.threadId ?? null,
                  projectId: input.projectId ?? null,
                  pendingRetry: null,
                });
              } else if (ownsHookFailure()) {
                registry.set(hookFailureAtom, null);
              }
              if (current.actionId === input.actionId && current.isRunning) {
                registry.set(
                  stateAtom,
                  failVcsActionState("run_change_request", input.actionId, error),
                );
              }
            }),
          ),
          Effect.onInterrupt(() =>
            Effect.andThen(
              Effect.sync(() => {
                const failure = registry.get(hookFailureAtom);
                if (failure !== null && ownsHookFailure()) {
                  registry.set(hookFailureAtom, { ...failure, pendingRetry: null });
                }
              }),
              clearOwnedState,
            ),
          ),
        );
      }),
    });
    runStackedActionCommands.set(commandKey, command);
    return command;
  };

  const setState = (
    registry: AtomRegistry.AtomRegistry,
    target: VcsActionTarget,
    update: (current: VcsActionState) => VcsActionState,
  ): void => {
    const key = getVcsActionTargetKey(target);
    if (key === null) {
      return;
    }
    const stateAtom = vcsActionStateAtom(key);
    registry.set(stateAtom, update(registry.get(stateAtom)));
  };

  return {
    stateAtom: getVcsActionStateAtom,
    runStackedAction: (target: VcsActionTarget) => getRunStackedActionCommand(target),
    /** The latest commit a hook rejected, with its transcript and retry context. */
    hookFailureAtom,
    /**
     * Retries the rejected commit on its original target with the same message and file selection.
     * The first attempt already created any feature branch, so the retry commits on it.
     * Resolves to null when there is nothing to retry or a retry is already running.
     */
    retryHookFailure: async (
      registry: AtomRegistry.AtomRegistry,
      input: RetryVcsHookFailureInput,
    ): Promise<AtomCommandResult<GitRunStackedActionResult, unknown> | null> => {
      const failure = registry.get(hookFailureAtom);
      if (failure === null || failure.pendingRetry !== null) {
        return null;
      }
      registry.set(hookFailureAtom, {
        ...failure,
        pendingRetry: { actionId: input.actionId, noVerify: input.noVerify },
      });
      return getRunStackedActionCommand(failure.target).run(registry, {
        actionId: input.actionId,
        action: failure.action,
        ...(failure.filePaths ? { filePaths: failure.filePaths } : {}),
        ...(failure.commitMessage ? { commitMessage: failure.commitMessage } : {}),
        ...(input.noVerify ? { noVerify: true } : {}),
        ...(failure.threadId !== null ? { threadId: failure.threadId } : {}),
        ...(failure.projectId !== null ? { projectId: failure.projectId } : {}),
      });
    },
    /** Closes the hook failure unless a retry of it is still running. */
    dismissHookFailure: (registry: AtomRegistry.AtomRegistry): void => {
      if (registry.get(hookFailureAtom)?.pendingRetry === null) {
        registry.set(hookFailureAtom, null);
      }
    },
    track: async <A, E>(
      registry: AtomRegistry.AtomRegistry,
      target: VcsActionTarget,
      input: BeginVcsActionInput,
      action: () => Promise<AtomCommandResult<A, E>>,
    ): Promise<AtomCommandResult<A, E | VcsActionUnavailableError>> => {
      const key = getVcsActionTargetKey(target);
      if (key === null) {
        return AsyncResult.failure<never, VcsActionUnavailableError>(
          Cause.fail(
            new VcsActionUnavailableError({
              operation: input.operation,
              environmentId: target.environmentId,
              cwd: target.cwd,
            }),
          ),
        );
      }
      const stateAtom = vcsActionStateAtom(key);
      const next = beginVcsActionState(input);
      registry.set(stateAtom, next);
      const result = await action();
      const current = registry.get(stateAtom);
      if (current.actionId !== next.actionId) {
        return result;
      }
      if (AsyncResult.isSuccess(result) || Cause.hasInterruptsOnly(result.cause)) {
        registry.set(stateAtom, EMPTY_VCS_ACTION_STATE);
      } else {
        if (registry.get(stateAtom).actionId === next.actionId) {
          registry.set(
            stateAtom,
            failVcsActionState(input.operation, next.actionId, Cause.squash(result.cause)),
          );
        }
      }
      return result;
    },
    resetError: (
      registry: AtomRegistry.AtomRegistry,
      target: VcsActionTarget,
      operation: VcsActionOperation,
    ): void => {
      setState(registry, target, (current) =>
        !current.isRunning && current.operation === operation ? EMPTY_VCS_ACTION_STATE : current,
      );
    },
  };
}
