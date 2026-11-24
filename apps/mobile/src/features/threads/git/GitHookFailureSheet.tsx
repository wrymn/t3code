import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { VcsHookFailure } from "@t3tools/client-runtime/state/vcs";
import { AuthSourceControlWriteScope } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useGT } from "gt-react-native";
import { Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { Sheet } from "../../../components/ui/Sheet";
import { uuidv4 } from "../../../lib/uuid";
import { appAtomRegistry } from "../../../state/atom-registry";
import { useEnvironmentScope } from "../../../state/session";
import { useAtomCommand } from "../../../state/use-atom-command";
import { showGitActionResult } from "../../../state/use-vcs-action-state";
import { vcsActionManager, vcsEnvironment } from "../../../state/vcs";
import { REVIEW_MONO_FONT_FAMILY } from "../../review/reviewDiffRendering";

/** Shows the commit a Git hook rejected, wherever it was started, until it is retried or closed. */
export function GitHookFailureSheetHost() {
  const failure = useAtomValue(vcsActionManager.hookFailureAtom);
  return failure ? <GitHookFailureSheet failure={failure} /> : null;
}

function GitHookFailureSheet({ failure }: { failure: VcsHookFailure }) {
  const gt = useGT();
  const insets = useSafeAreaInsets();
  const canWrite = useEnvironmentScope(failure.target.environmentId, AuthSourceControlWriteScope);
  const refreshStatus = useAtomCommand(vcsEnvironment.refreshStatus, { reportFailure: false });
  const retrying = failure.pendingRetry;
  const repository = failure.target.cwd.split(/[\\/]/).findLast(Boolean) ?? failure.target.cwd;
  const output = failure.transcript.lines.join("\n");
  const threadRef =
    failure.threadId === null
      ? null
      : scopeThreadRef(failure.target.environmentId, failure.threadId);

  const retry = async (noVerify: boolean) => {
    const result = await vcsActionManager.retryHookFailure(appAtomRegistry, {
      actionId: uuidv4(),
      noVerify,
    });
    if (result === null) return;
    void refreshStatus({
      environmentId: failure.target.environmentId,
      input: { cwd: failure.target.cwd },
    });
    // Results are shown in the thread that started the action; without one there is nowhere to show them.
    if (threadRef === null) return;
    if (AsyncResult.isSuccess(result)) {
      showGitActionResult({
        threadRef,
        type: "success",
        title: result.value.toast.title,
        description: result.value.toast.description,
      });
      return;
    }
    // A repeated rejection updates this sheet instead of raising a banner.
    if (
      Cause.hasInterruptsOnly(result.cause) ||
      appAtomRegistry.get(vcsActionManager.hookFailureAtom)
    )
      return;
    const error = Cause.squash(result.cause);
    showGitActionResult({
      threadRef,
      type: "error",
      title: gt("Commit failed"),
      description: error instanceof Error ? error.message : gt("Git action failed."),
    });
  };

  return (
    <Sheet
      title={gt("Commit blocked")}
      onClose={() => vcsActionManager.dismissHookFailure(appAtomRegistry)}
    >
      <ScrollView
        nestedScrollEnabled
        className="flex-1"
        contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 12, paddingBottom: 20 }}
      >
        <Text className="pb-4 text-sm text-foreground-muted" numberOfLines={1}>
          {gt("{hook} hook · {repository}", { hook: failure.hookName, repository })}
        </Text>
        <View className="overflow-hidden rounded-xl bg-card-alt p-3">
          <View className="flex-row justify-between gap-3 pb-2">
            <Text className="text-xs text-foreground-muted">
              {gt("Hook output · exit {code}", { code: failure.exitCode })}
            </Text>
            {failure.transcript.droppedLines > 0 ? (
              <Text className="text-xs text-foreground-muted">
                {gt(
                  "{count, plural, one {{count} earlier line trimmed} other {{count} earlier lines trimmed}}",
                  { count: failure.transcript.droppedLines },
                )}
              </Text>
            ) : null}
          </View>
          <Text
            selectable
            accessibilityLabel={gt("{hook} hook output", { hook: failure.hookName })}
            className="text-xs text-foreground"
            style={{ fontFamily: REVIEW_MONO_FONT_FAMILY }}
          >
            {output || gt("The hook printed no output.")}
          </Text>
        </View>
        <Text className="pt-4 text-xs text-foreground-muted">
          {failure.canSkipVerification
            ? gt(
                "Skipping verification bypasses all pre-commit and commit-message checks for this commit, including asset-lock checks.",
              )
            : gt("{hook} cannot be skipped.", { hook: failure.hookName })}
        </Text>
      </ScrollView>
      <View
        className="gap-3 border-t border-border px-5 pt-4"
        style={{ paddingBottom: Math.max(16, insets.bottom) }}
      >
        <Button
          label={gt("Retry")}
          tone="primary"
          fullWidth
          loading={retrying !== null && !retrying.noVerify}
          disabled={!canWrite || retrying !== null}
          onPress={() => void retry(false)}
        />
        {failure.canSkipVerification ? (
          <Button
            label={gt("Skip checks and commit")}
            accessibilityHint={gt("Commits without running pre-commit and commit-message checks")}
            tone="secondary"
            fullWidth
            loading={retrying?.noVerify === true}
            disabled={!canWrite || retrying !== null}
            onPress={() => void retry(true)}
          />
        ) : null}
      </View>
    </Sheet>
  );
}
