import { ChevronDownIcon } from "lucide-react";
import type { GitStackedAction } from "@t3tools/contracts";
import { useId, useRef } from "react";

import { Button } from "~/components/ui/button";
import { ButtonGroup, ButtonGroupSeparator } from "~/components/ui/group";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

/** The existing Git action identifiers accepted by the staging control. */
export type StagingCommitChoiceId = GitStackedAction;

export interface StagingCommitChoice {
  readonly id: StagingCommitChoiceId;
  /** Host-specific label, e.g. "Commit, push & create MR". */
  readonly label: string;
  /** Why the choice cannot run now. Null or omitted means it can. */
  readonly disabledReason?: string | null;
  /** Secondary line, such as the branch a push lands on. Hidden while disabled. */
  readonly detail?: string | null;
}

/**
 * Split button for the staging footer. The primary button always runs `commit` (staged files only);
 * the menu lists `commit` first, then `moreChoices` in the order given. The parent owns availability,
 * labels and running the action; nothing is remembered between uses.
 */
export function StagingCommitControl(props: {
  readonly commit: StagingCommitChoice;
  /** Extra menu rows such as commit & push, push only, or create PR/MR. Empty hides the menu. */
  readonly moreChoices: readonly StagingCommitChoice[];
  /** Shared in-flight status such as "Pushing...". Disables both buttons while set. */
  readonly busyLabel: string | null;
  readonly onSelect: (id: StagingCommitChoiceId) => void;
}) {
  const { commit, moreChoices, busyLabel, onSelect } = props;
  const anchorRef = useRef<HTMLDivElement>(null);
  const reasonId = useId();
  const commitReason = busyLabel === null ? (commit.disabledReason ?? null) : null;

  return (
    <ButtonGroup ref={anchorRef} className="w-full" aria-label="Commit actions">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              className="min-w-0 flex-1"
              size="compact"
              aria-disabled={commitReason !== null || busyLabel !== null || undefined}
              aria-describedby={commitReason !== null ? reasonId : undefined}
              onClick={() => {
                if (commitReason === null && busyLabel === null) onSelect(commit.id);
              }}
            />
          }
        >
          {busyLabel !== null ? (
            <>
              <Spinner aria-hidden="true" />
              <span className="truncate">{busyLabel}</span>
            </>
          ) : (
            <span className="truncate">{commit.label}</span>
          )}
        </TooltipTrigger>
        {commitReason !== null ? <TooltipPopup side="top">{commitReason}</TooltipPopup> : null}
      </Tooltip>
      {commitReason !== null ? (
        <span id={reasonId} className="sr-only">
          {commitReason}
        </span>
      ) : null}
      {moreChoices.length > 0 ? (
        <>
          <ButtonGroupSeparator />
          <Menu>
            <MenuTrigger
              render={<Button size="compact" aria-label="More commit actions" />}
              disabled={busyLabel !== null}
            >
              <ChevronDownIcon aria-hidden="true" />
            </MenuTrigger>
            <MenuPopup side="top" align="end" anchor={anchorRef} className="w-(--anchor-width)">
              {[commit, ...moreChoices].map((choice) => (
                <MenuItem
                  key={choice.id}
                  disabled={choice.disabledReason != null}
                  aria-label={choice.label}
                  aria-describedby={`${reasonId}-${choice.id}`}
                  onClick={() => onSelect(choice.id)}
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{choice.label}</span>
                    {choice.disabledReason != null ? (
                      <span
                        id={`${reasonId}-${choice.id}`}
                        className="text-xs text-muted-foreground"
                      >
                        {choice.disabledReason}
                      </span>
                    ) : choice.detail != null ? (
                      <span
                        id={`${reasonId}-${choice.id}`}
                        className="truncate font-mono text-2xs text-muted-foreground/70"
                      >
                        {choice.detail}
                      </span>
                    ) : null}
                  </span>
                </MenuItem>
              ))}
            </MenuPopup>
          </Menu>
        </>
      ) : null}
      <span role="status" className="sr-only">
        {busyLabel}
      </span>
    </ButtonGroup>
  );
}
