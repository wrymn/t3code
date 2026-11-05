import { vi } from "vite-plus/test";
import {
  EnvironmentId,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  ThreadId,
  ProjectId,
  WS_METHODS,
  GitCommandError,
  type GitActionProgressEvent,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { AtomCommandResult } from "./runtime.ts";
import {
  appendVcsHookTranscript,
  applyVcsActionProgressEvent,
  beginVcsActionState,
  consumeVcsActionProgress,
  createVcsActionManager,
  createVcsActionTransportId,
  EMPTY_VCS_ACTION_STATE,
  EMPTY_VCS_HOOK_TRANSCRIPT,
  normalizeVcsActionProgressEvent,
  parseVcsActionTargetKey,
  VCS_HOOK_TRANSCRIPT_MAX_CHARS,
  VCS_HOOK_TRANSCRIPT_MAX_LINES,
  VcsActionHookRejectedError,
  VcsActionMissingTerminalEventError,
  VcsActionRemoteFailureError,
  VcsActionTargetKeyParseError,
} from "./vcsAction.ts";
import { vcsRefsCacheStateAtom } from "./vcsRefInvalidation.ts";

const actionId = "action-123";
const action = "commit_push" as const;
const cwd = "/repo";
const environmentId = EnvironmentId.make("environment-1");
const result: GitRunStackedActionResult = {
  action,
  branch: {
    status: "skipped_not_requested",
  },
  commit: {
    status: "created",
    commitSha: "abc123",
    subject: "Test commit",
  },
  push: {
    status: "pushed",
    branch: "feature",
  },
  pr: {
    status: "skipped_not_requested",
  },
  toast: {
    title: "Changes pushed",
    cta: {
      kind: "none",
    },
  },
};

const target = new PrimaryConnectionTarget({
  environmentId,
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

function session(client: WsRpcProtocolClient): RpcSession {
  return {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: (input = {}) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
}

function progress<T extends GitActionProgressEvent>(event: T): T {
  return event;
}

function cacheStore(onClearVcsRefs: (environmentId: EnvironmentId) => void) {
  return Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeedNone,
    saveShell: () => Effect.void,
    loadThread: () => Effect.succeedNone,
    saveThread: () => Effect.void,
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeedNone,
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeedNone,
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: (environmentId) => Effect.sync(() => onClearVcsRefs(environmentId)),
    clear: () => Effect.void,
  });
}

function stackedActionHarness(
  respond: (input: GitRunStackedActionInput) => Stream.Stream<GitActionProgressEvent>,
) {
  return Effect.gen(function* () {
    const connectionState: SupervisorConnectionState = {
      ...AVAILABLE_CONNECTION_STATE,
      desired: true,
      network: "online",
      phase: "connected",
      attempt: 1,
      generation: 1,
    };
    const rpcInputs = new Array<GitRunStackedActionInput>();
    const client = {
      [WS_METHODS.gitRunStackedAction]: (input: GitRunStackedActionInput) => {
        rpcInputs.push(input);
        return respond(input);
      },
    } as unknown as WsRpcProtocolClient;
    const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
      target,
      state: yield* SubscriptionRef.make(connectionState),
      session: yield* SubscriptionRef.make(Option.some(session(client))),
      prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
    const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (
      _environmentId,
      effect,
    ) => Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
    const runStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["runStream"] = (
      _environmentId,
      stream,
    ) => Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
    const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
      run,
      runStream,
    } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
    const removed = new Array<string>();
    const runtime = Atom.runtime(
      Layer.merge(
        Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry),
        Layer.succeed(
          Persistence.EnvironmentCacheStore,
          cacheStore((removedEnvironmentId) => {
            removed.push(`${removedEnvironmentId}:*`);
          }),
        ),
      ),
    );
    const manager = createVcsActionManager(runtime);
    const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
      Effect.sync(() => registry.dispose()),
    );
    return { manager, registry, rpcInputs, removed };
  });
}

describe("vcsActionState", () => {
  it("preserves malformed target key diagnostics and the native cause without copying the key", () => {
    const key = "not-json-with-credential=do-not-log";
    let error: unknown;

    try {
      parseVcsActionTargetKey(key);
    } catch (cause) {
      error = cause;
    }

    expect(error).toBeInstanceOf(VcsActionTargetKeyParseError);
    expect(error).toMatchObject({ keyLength: key.length, cause: expect.any(SyntaxError) });
    expect(error).not.toHaveProperty("key");
    expect((error as Error).message).not.toContain(key);
  });

  it("projects phase and hook progress without owning the async operation", () => {
    const initial = beginVcsActionState({
      operation: "run_change_request",
      label: "Running source control action",
      actionId,
    });
    const phase = applyVcsActionProgressEvent(
      initial,
      progress({
        actionId,
        action,
        cwd,
        kind: "phase_started",
        phase: "commit",
        label: "Committing...",
        commitMessage: "Generated subject\n\nGenerated body",
      }),
    );
    const early = applyVcsActionProgressEvent(
      phase,
      progress({
        actionId,
        action,
        cwd,
        kind: "hook_output",
        hookName: null,
        stream: "stderr",
        text: "\u001b[31mprinted before trace2\u001b[0m\u0007",
      }),
    );
    const hook = applyVcsActionProgressEvent(
      early,
      progress({
        actionId,
        action,
        cwd,
        kind: "hook_started",
        hookName: "post-commit",
      }),
    );
    const output = applyVcsActionProgressEvent(
      hook,
      progress({
        actionId,
        action,
        cwd,
        kind: "hook_output",
        hookName: "post-commit",
        stream: "stdout",
        text: "hook output",
      }),
    );
    const finished = applyVcsActionProgressEvent(
      output,
      progress({
        actionId,
        action,
        cwd,
        kind: "hook_finished",
        hookName: "post-commit",
        exitCode: 0,
        durationMs: 12,
      }),
    );

    expect(phase).toMatchObject({
      isRunning: true,
      currentLabel: "Committing...",
      currentPhaseLabel: "Committing...",
    });
    expect(output).toMatchObject({
      currentLabel: "Running post-commit...",
      hookName: "post-commit",
      lastOutputLine: "hook output",
    });
    expect(finished).toMatchObject({
      currentLabel: "Committing...",
      hookName: null,
      lastOutputLine: null,
      commitMessage: "Generated subject\n\nGenerated body",
      hookTranscript: { lines: ["printed before trace2", "hook output"], droppedLines: 0 },
    });
    expect(
      applyVcsActionProgressEvent(
        finished,
        progress({
          actionId,
          action,
          cwd,
          kind: "phase_started",
          phase: "push",
          label: "Pushing...",
        }),
      ).hookTranscript,
    ).toEqual(EMPTY_VCS_HOOK_TRANSCRIPT);
  });

  it("keeps the newest hook output within the line and character bounds", () => {
    let transcript = EMPTY_VCS_HOOK_TRANSCRIPT;
    for (let line = 1; line <= VCS_HOOK_TRANSCRIPT_MAX_LINES + 50; line += 1) {
      transcript = appendVcsHookTranscript(transcript, `line ${line}`);
    }
    expect(transcript.lines).toHaveLength(VCS_HOOK_TRANSCRIPT_MAX_LINES);
    expect(transcript.lines[0]).toBe("line 51");
    expect(transcript.droppedLines).toBe(50);

    const huge = appendVcsHookTranscript(transcript, "x".repeat(VCS_HOOK_TRANSCRIPT_MAX_CHARS * 2));
    expect(huge.lines).toEqual(["x".repeat(VCS_HOOK_TRANSCRIPT_MAX_CHARS)]);
    expect(huge.chars).toBe(VCS_HOOK_TRANSCRIPT_MAX_CHARS);
    expect(huge.droppedLines).toBe(50 + VCS_HOOK_TRANSCRIPT_MAX_LINES);
  });

  it("ignores progress after a newer action owns the target", () => {
    const current = beginVcsActionState({
      operation: "pull",
      label: "Pulling latest changes",
      actionId: "newer-action",
    });

    expect(
      applyVcsActionProgressEvent(
        current,
        progress({
          actionId,
          action,
          cwd,
          kind: "phase_started",
          phase: "push",
          label: "Pushing...",
        }),
      ),
    ).toBe(current);
  });

  it("normalizes progress only for the matching environment-scoped action", () => {
    const target = { environmentId, cwd };
    const otherTarget = {
      environmentId: EnvironmentId.make("environment-2"),
      cwd,
    };
    const transportActionId = createVcsActionTransportId(target, actionId);
    const event = progress({
      actionId: createVcsActionTransportId(otherTarget, actionId),
      action,
      cwd,
      kind: "phase_started",
      phase: "push",
      label: "Pushing...",
    });

    expect(normalizeVcsActionProgressEvent(target, transportActionId, actionId, event)).toBeNull();
    expect(
      normalizeVcsActionProgressEvent(target, transportActionId, actionId, {
        ...event,
        actionId: transportActionId,
      }),
    ).toEqual({
      ...event,
      actionId,
    });
  });

  it.effect("consumes progress through the terminal event and returns its result", () =>
    Effect.gen(function* () {
      const target = { environmentId, cwd };
      const transportActionId = createVcsActionTransportId(target, actionId);
      const observed: GitActionProgressEvent[] = [];
      const events: GitActionProgressEvent[] = [
        {
          actionId: "unrelated-action",
          action,
          cwd,
          kind: "phase_started",
          phase: "commit",
          label: "Ignored",
        },
        {
          actionId: transportActionId,
          action,
          cwd,
          kind: "phase_started",
          phase: "push",
          label: "Pushing...",
        },
        {
          actionId: transportActionId,
          action,
          cwd,
          kind: "action_finished",
          result,
        },
      ];

      const actual = yield* consumeVcsActionProgress(Stream.fromIterable(events), {
        target,
        transportActionId,
        actionId,
        action,
        onProgress: (event) =>
          Effect.sync(() => {
            observed.push(event);
          }),
      });

      expect(actual).toEqual(result);
      expect(observed.map((event) => event.actionId)).toEqual([actionId, actionId]);
      expect(observed.map((event) => event.kind)).toEqual(["phase_started", "action_finished"]);
    }),
  );

  it.effect("retains structural remote failure context without copying the remote payload", () =>
    Effect.gen(function* () {
      const target = { environmentId, cwd };
      const transportActionId = createVcsActionTransportId(target, actionId);
      const remoteMessage = "The remote rejected the push with credential=do-not-log.";
      const error = yield* consumeVcsActionProgress(
        Stream.fromIterable<GitActionProgressEvent>([
          {
            actionId: transportActionId,
            action,
            cwd,
            kind: "action_failed",
            phase: "push",
            message: remoteMessage,
          },
        ]),
        {
          target,
          transportActionId,
          actionId,
          action,
          onProgress: () => Effect.void,
        },
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(VcsActionRemoteFailureError);
      expect(error).toMatchObject({
        actionId,
        transportActionId,
        action,
        environmentId,
        cwd,
        phase: "push",
        remoteMessageLength: remoteMessage.length,
      });
      expect(error).not.toHaveProperty("detail");
      expect(error.message).toBe("Source control action 'commit_push' failed during push.");
      expect(error.message).not.toContain(remoteMessage);
    }),
  );

  it.effect("reports a gating hook rejection without copying its output", () =>
    Effect.gen(function* () {
      const target = { environmentId, cwd };
      const transportActionId = createVcsActionTransportId(target, actionId);
      const consume = (hookName: string, phase: "commit" | "push") =>
        consumeVcsActionProgress(
          Stream.fromIterable<GitActionProgressEvent>([
            {
              actionId: transportActionId,
              action,
              cwd,
              kind: "phase_started",
              phase: "commit",
              label: "Committing...",
            },
            {
              actionId: transportActionId,
              action,
              cwd,
              kind: "hook_output",
              hookName,
              stream: "stderr",
              text: "secret=do-not-log",
            },
            {
              actionId: transportActionId,
              action,
              cwd,
              kind: "hook_finished",
              hookName,
              exitCode: 1,
              durationMs: 4,
            },
            {
              actionId: transportActionId,
              action,
              cwd,
              kind: "action_failed",
              phase,
              message: "hook failed secret=do-not-log",
            },
          ]).pipe(
            Stream.concat(
              Stream.fail(
                new GitCommandError({
                  operation: "commit",
                  command: "git",
                  cwd,
                  detail: "Git command failed",
                }),
              ),
            ),
          ),
          { target, transportActionId, actionId, action, onProgress: () => Effect.void },
        ).pipe(Effect.flip);

      const rejected = yield* consume("pre-commit", "commit");
      expect(rejected).toBeInstanceOf(VcsActionHookRejectedError);
      expect(rejected).toMatchObject({ hookName: "pre-commit", exitCode: 1, environmentId, cwd });
      expect(rejected.message).toBe("The pre-commit hook rejected the commit (exit code 1).");
      expect(JSON.stringify(rejected)).not.toContain("do-not-log");

      expect(yield* consume("post-commit", "commit")).toBeInstanceOf(VcsActionRemoteFailureError);
      expect(yield* consume("pre-commit", "push")).toBeInstanceOf(VcsActionRemoteFailureError);
    }),
  );

  it.effect("reports a missing terminal event as a protocol failure", () =>
    Effect.gen(function* () {
      const target = { environmentId, cwd };
      const transportActionId = createVcsActionTransportId(target, actionId);
      const error = yield* consumeVcsActionProgress(
        Stream.fromIterable<GitActionProgressEvent>([
          {
            actionId: transportActionId,
            action,
            cwd,
            kind: "phase_started",
            phase: "commit",
            label: "Committing...",
          },
        ]),
        {
          target,
          transportActionId,
          actionId,
          action,
          onProgress: () => Effect.void,
        },
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(VcsActionMissingTerminalEventError);
      expect(error).toMatchObject({
        actionId,
        transportActionId,
        action,
        environmentId,
        cwd,
      });
      expect(error.message).toBe(
        "Source control action 'commit_push' ended without a terminal result.",
      );
    }),
  );

  it("tracks finite mutations without letting an older completion clear newer state", async () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry.EnvironmentRegistry | Persistence.EnvironmentCacheStore,
      never
    >;
    const manager = createVcsActionManager(runtime);
    const registry = AtomRegistry.make();
    const target = { environmentId, cwd };
    let finishFirst!: () => void;
    let failSecond!: (error: Error) => void;
    const firstAction = new Promise<AtomCommandResult<void, never>>((resolve) => {
      finishFirst = () => resolve(AsyncResult.success(undefined));
    });
    const secondAction = new Promise<AtomCommandResult<void, Error>>((resolve) => {
      failSecond = (error) => resolve(AsyncResult.failure(Cause.fail(error)));
    });

    const first = manager.track(
      registry,
      target,
      { operation: "pull", label: "Pulling latest changes" },
      () => firstAction,
    );
    const firstActionId = registry.get(manager.stateAtom(target)).actionId;
    const second = manager.track(
      registry,
      target,
      { operation: "switch_ref", label: "Switching branch" },
      () => secondAction,
    );
    const secondActionId = registry.get(manager.stateAtom(target)).actionId;

    finishFirst();
    await first;
    expect(registry.get(manager.stateAtom(target))).toMatchObject({
      actionId: secondActionId,
      isRunning: true,
      operation: "switch_ref",
    });
    expect(secondActionId).not.toBe(firstActionId);

    failSecond(new Error("switch failed"));
    const secondFailure = await second;
    expect(AsyncResult.isFailure(secondFailure)).toBe(true);
    expect(registry.get(manager.stateAtom(target))).toMatchObject({
      actionId: secondActionId,
      error: "switch failed",
      isRunning: false,
      operation: "switch_ref",
    });

    registry.dispose();
  });

  it.effect("invalidates persisted refs after successful and failed stacked actions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const targetKey = { environmentId, cwd };
        const successfulActionId = "invalidate-success";
        const failedActionId = "invalidate-failure";
        const interruptedActionId = "invalidate-interrupted";
        const successfulTransportActionId = createVcsActionTransportId(
          targetKey,
          successfulActionId,
        );
        const failedTransportActionId = createVcsActionTransportId(targetKey, failedActionId);
        const interruptedTransportActionId = createVcsActionTransportId(
          targetKey,
          interruptedActionId,
        );
        const { manager, registry, rpcInputs, removed } = yield* stackedActionHarness((input) =>
          input.actionId === successfulTransportActionId
            ? Stream.make(
                progress({
                  kind: "action_finished",
                  actionId: successfulTransportActionId,
                  cwd,
                  action,
                  result,
                }),
              )
            : input.actionId === interruptedTransportActionId
              ? Stream.fromEffect(Effect.interrupt)
              : Stream.make(
                  progress({
                    kind: "action_failed",
                    actionId: failedTransportActionId,
                    cwd,
                    action,
                    phase: "push",
                    message: "push failed after creating the branch",
                  }),
                ),
        );
        const state = vcsRefsCacheStateAtom({ environmentId });

        expect(registry.get(state).revision).toBe(0);
        const threadId = ThreadId.make("thread-stacked-action");
        const projectId = ProjectId.make("project-stacked-action");
        const successfulResult = yield* Effect.promise(() =>
          manager.runStackedAction(targetKey).run(registry, {
            actionId: successfulActionId,
            action,
            threadId,
            projectId,
          }),
        );

        expect(AsyncResult.isSuccess(successfulResult)).toBe(true);
        expect(registry.get(manager.stateAtom(targetKey))).toEqual(EMPTY_VCS_ACTION_STATE);
        expect(registry.get(state).revision).toBe(1);
        expect(removed).toEqual([`${environmentId}:*`]);
        expect(rpcInputs).toEqual([
          { actionId: successfulTransportActionId, cwd, action, threadId, projectId },
        ]);

        const failedResult = yield* Effect.promise(() =>
          manager.runStackedAction(targetKey).run(registry, {
            actionId: failedActionId,
            action,
          }),
        );

        expect(AsyncResult.isFailure(failedResult)).toBe(true);
        expect(registry.get(manager.stateAtom(targetKey))).toMatchObject({
          isRunning: false,
          operation: "run_change_request",
          actionId: failedActionId,
          error: "Source control action 'commit_push' failed during push.",
        });
        expect(registry.get(manager.hookFailureAtom)).toBeNull();
        expect(registry.get(state).revision).toBe(2);
        expect(removed).toEqual([`${environmentId}:*`, `${environmentId}:*`]);

        const interruptedResult = yield* Effect.promise(() =>
          manager.runStackedAction(targetKey).run(registry, {
            actionId: interruptedActionId,
            action,
          }),
        );

        expect(AsyncResult.isFailure(interruptedResult)).toBe(true);
        if (AsyncResult.isFailure(interruptedResult)) {
          expect(Cause.hasInterruptsOnly(interruptedResult.cause)).toBe(true);
        }
        expect(registry.get(manager.stateAtom(targetKey))).toEqual(EMPTY_VCS_ACTION_STATE);
        expect(registry.get(state).revision).toBe(3);
        expect(removed).toEqual([`${environmentId}:*`, `${environmentId}:*`, `${environmentId}:*`]);
      }),
    ),
  );
  it.effect("retains a hook rejection for one-shot retries on its original target", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const targetKey = { environmentId, cwd };
        const threadId = ThreadId.make("thread-hook-retry");
        const outcomes = ["reject", "reject", "succeed", "reject", "succeed", "reject"];
        let attempt = 0;
        const { manager, registry, rpcInputs } = yield* stackedActionHarness((input) => {
          const base = { actionId: input.actionId, cwd, action: input.action };
          attempt += 1;
          if (outcomes.shift() === "succeed") {
            return Stream.make(progress({ ...base, kind: "action_finished", result }));
          }
          return Stream.fromIterable<GitActionProgressEvent>([
            {
              ...base,
              kind: "phase_started",
              phase: "commit",
              label: "Committing...",
              commitMessage: "Resolved subject",
            },
            {
              ...base,
              kind: "hook_output",
              hookName: null,
              stream: "stdout",
              text: "checking assets",
            },
            { ...base, kind: "hook_started", hookName: "pre-commit" },
            {
              ...base,
              kind: "hook_output",
              hookName: "pre-commit",
              stream: "stderr",
              text: `attempt ${attempt}`,
            },
            { ...base, kind: "hook_finished", hookName: "pre-commit", exitCode: 2, durationMs: 3 },
            { ...base, kind: "action_failed", phase: "commit", message: "pre-commit failed" },
          ]);
        });
        const runFresh = (id: string) =>
          Effect.promise(() =>
            manager.runStackedAction(targetKey).run(registry, {
              actionId: id,
              action,
              featureBranch: true,
              filePaths: ["src/a.ts"],
              threadId,
            }),
          );
        const retry = (id: string, noVerify: boolean) =>
          Effect.promise(() => manager.retryHookFailure(registry, { actionId: id, noVerify }));

        const rejected = yield* runFresh("hook-first");
        expect(AsyncResult.isFailure(rejected) && Cause.squash(rejected.cause)).toBeInstanceOf(
          VcsActionHookRejectedError,
        );
        expect(registry.get(manager.hookFailureAtom)).toEqual({
          target: targetKey,
          actionId: "hook-first",
          action,
          hookName: "pre-commit",
          exitCode: 2,
          transcript: { lines: ["checking assets", "attempt 1"], chars: 24, droppedLines: 0 },
          canSkipVerification: true,
          commitMessage: "Resolved subject",
          filePaths: ["src/a.ts"],
          threadId,
          projectId: null,
          pendingRetry: null,
        });

        yield* retry("hook-bypass", true);
        expect(rpcInputs[1]).toEqual({
          actionId: createVcsActionTransportId(targetKey, "hook-bypass"),
          cwd,
          action,
          commitMessage: "Resolved subject",
          filePaths: ["src/a.ts"],
          noVerify: true,
          threadId,
        });
        expect(registry.get(manager.hookFailureAtom)).toMatchObject({
          actionId: "hook-bypass",
          transcript: { lines: ["checking assets", "attempt 2"] },
          pendingRetry: null,
        });

        const retried = yield* retry("hook-retry", false);
        expect(retried !== null && AsyncResult.isSuccess(retried)).toBe(true);
        expect(rpcInputs[2]).not.toHaveProperty("noVerify");
        expect(rpcInputs[2]).toMatchObject({
          filePaths: ["src/a.ts"],
          commitMessage: "Resolved subject",
        });
        expect(registry.get(manager.hookFailureAtom)).toBeNull();
        expect(yield* retry("nothing-to-retry", false)).toBeNull();

        yield* runFresh("hook-second");
        expect(registry.get(manager.hookFailureAtom)).not.toBeNull();
        yield* runFresh("fresh-success");
        expect(rpcInputs[4]).not.toHaveProperty("noVerify");
        expect(rpcInputs[4]).toMatchObject({ featureBranch: true, filePaths: ["src/a.ts"] });
        expect(registry.get(manager.hookFailureAtom)).toBeNull();

        yield* runFresh("hook-dismissed");
        manager.dismissHookFailure(registry);
        expect(registry.get(manager.hookFailureAtom)).toBeNull();
        expect(rpcInputs).toHaveLength(6);
      }),
    ),
  );
});

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: grantedSessions }),
}));
const grantedSessions = Atom.family((_id: EnvironmentId) =>
  Atom.make(
    AsyncResult.success({
      authenticated: true,
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "test",
      },
      scopes: [AuthOrchestrationReadScope, AuthSourceControlWriteScope],
    }),
  ),
);
