import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import { formatEnvironmentQueryError } from "./query";

describe("formatEnvironmentQueryError", () => {
  it.each([
    [Cause.die("Unknown request tag: vcs.getStagingStatus"), /too old for this feature/],
    [Cause.fail(new Error("git failed")), /^git failed$/],
    [Cause.die({}), /^The environment request failed\.$/],
  ])("formats %#", (cause, expected) => {
    expect(formatEnvironmentQueryError(cause)).toMatch(expected);
  });
});
