import { useAtomValue } from "@effect/atom-react";
import type { VcsHookFailure } from "@t3tools/client-runtime/state/vcs";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AuthSourceControlWriteScope } from "@t3tools/contracts";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { vcsActionManager, vcsEnvironment } from "~/state/vcs";
import { randomUUID } from "~/lib/utils";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Spinner } from "./ui/spinner";
import { toastManager } from "./ui/toast";

/** Shows the commit a Git hook rejected, wherever it was started, until it is retried or closed. */
export function GitHookFailureDialogHost() {
  const failure = useAtomValue(vcsActionManager.hookFailureAtom);
  return failure ? <GitHookFailureDialog failure={failure} /> : null;
}

function GitHookFailureDialog({ failure }: { failure: VcsHookFailure }) {
  const canWrite = useEnvironmentScope(failure.target.environmentId, AuthSourceControlWriteScope);
  const refreshStatus = useAtomCommand(vcsEnvironment.refreshStatus, { reportFailure: false });
  const retrying = failure.pendingRetry;
  const repository = failure.target.cwd.split(/[\\/]/).findLast(Boolean) ?? failure.target.cwd;
  const output = failure.transcript.lines.join("\n");

  const retry = async (noVerify: boolean) => {
    const result = await vcsActionManager.retryHookFailure(appAtomRegistry, {
      actionId: randomUUID(),
      noVerify,
    });
    if (result === null) return;
    void refreshStatus({
      environmentId: failure.target.environmentId,
      input: { cwd: failure.target.cwd },
    });
    if (result._tag === "Success") {
      toastManager.add({
        type: "success",
        title: result.value.toast.title,
        ...(result.value.toast.description ? { description: result.value.toast.description } : {}),
      });
      return;
    }
    // A repeated rejection updates this dialog instead of raising a toast.
    if (isAtomCommandInterrupted(result) || appAtomRegistry.get(vcsActionManager.hookFailureAtom))
      return;
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: "Commit failed",
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) vcsActionManager.dismissHookFailure(appAtomRegistry);
      }}
    >
      <DialogPopup className="sm:max-w-2xl" showCloseButton={retrying === null}>
        <DialogHeader>
          <DialogTitle>Commit blocked</DialogTitle>
          <DialogDescription>
            <code className="font-mono">{failure.hookName}</code> hook · {repository}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="overflow-hidden rounded-lg border bg-muted/40">
            <div className="flex items-center justify-between border-b px-3 py-1.5 text-muted-foreground text-xs">
              <span>Hook output · exit {failure.exitCode}</span>
              {failure.transcript.droppedLines > 0 ? (
                <span>{failure.transcript.droppedLines} earlier lines trimmed</span>
              ) : null}
            </div>
            <pre
              aria-label={`${failure.hookName} hook output`}
              className="max-h-72 min-h-16 select-text overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-foreground text-xs leading-relaxed"
            >
              {output || "The hook printed no output."}
            </pre>
          </div>
          <p className="text-muted-foreground text-xs">
            {failure.canSkipVerification
              ? "Skipping verification bypasses all pre-commit and commit-message checks for this commit only."
              : `${failure.hookName} cannot be skipped.`}
          </p>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={retrying !== null}
            onClick={() => vcsActionManager.dismissHookFailure(appAtomRegistry)}
          >
            Close
          </Button>
          {failure.canSkipVerification ? (
            <Button
              variant="destructive-outline"
              disabled={!canWrite || retrying !== null}
              onClick={() => void retry(true)}
            >
              {retrying?.noVerify ? <Spinner /> : null}
              Skip checks and commit
            </Button>
          ) : null}
          <Button
            autoFocus
            disabled={!canWrite || retrying !== null}
            onClick={() => void retry(false)}
          >
            {retrying && !retrying.noVerify ? <Spinner /> : null}
            Retry
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
