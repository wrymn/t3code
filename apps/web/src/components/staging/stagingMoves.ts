import type { VcsStagingFile, VcsStagingStatusResult } from "@t3tools/contracts";

export type StagingListKind = "unstaged" | "staged";

/** A stage, unstage, or discard the server has not confirmed through a fresh status yet. */
export interface StagingMove {
  readonly id: number;
  readonly from: StagingListKind;
  /** Null discards: the files leave `from` and go nowhere. */
  readonly to: StagingListKind | null;
  readonly files: ReadonlyArray<VcsStagingFile>;
  /** When the command finished, or null while it runs. */
  readonly settledAt: number | null;
}

/** Marks moves finished now, comparable with the status query's update time. */
export function settleStagingMove(now: () => number) {
  const settledAt = now();
  return (move: StagingMove): StagingMove => ({ ...move, settledAt });
}

/**
 * A move stays applied until a status fetched after its command finished has replaced it.
 * A same-millisecond tie retires it: a stuck move would hide real files until the next refresh.
 */
export function isStagingMoveActive(move: StagingMove, statusUpdatedAt: number): boolean {
  return move.settledAt === null || statusUpdatedAt < move.settledAt;
}

/**
 * The status the panel shows: the server's lists with unconfirmed moves applied in order.
 * The server's next status replaces this guess, so a change kind only needs to be close.
 */
export function applyStagingMoves(
  status: VcsStagingStatusResult,
  moves: ReadonlyArray<StagingMove>,
): VcsStagingStatusResult {
  if (moves.length === 0) return status;
  const lists = { unstaged: [...status.unstaged], staged: [...status.staged] };
  for (const move of moves) {
    const paths = new Set(move.files.map((file) => file.path));
    lists[move.from] = lists[move.from].filter((file) => !paths.has(file.path));
    if (move.to === null) continue;
    const target = lists[move.to];
    for (const file of move.files) {
      const index = target.findIndex((entry) => entry.path === file.path);
      const existing = target[index];
      // A partly edited rename must keep its old path, or restaging it drops the deletion.
      if (existing)
        target[index] = { ...existing, previousPath: file.previousPath ?? existing.previousPath };
      else insertInGitOrder(target, { ...file, change: changeIn(move.to, file.change) });
    }
  }
  return { ...status, ...lists };
}

function changeIn(list: StagingListKind, change: VcsStagingFile["change"]) {
  if (list === "staged" && change === "untracked") return "added";
  if (list === "unstaged" && change === "added") return "untracked";
  return change;
}

// Git status lists tracked paths in byte order, then untracked ones.
function insertInGitOrder(files: VcsStagingFile[], file: VcsStagingFile) {
  const rank = (entry: VcsStagingFile) => (entry.change === "untracked" ? 1 : 0);
  const index = files.findIndex(
    (entry) => rank(entry) > rank(file) || (rank(entry) === rank(file) && entry.path > file.path),
  );
  files.splice(index === -1 ? files.length : index, 0, file);
}
