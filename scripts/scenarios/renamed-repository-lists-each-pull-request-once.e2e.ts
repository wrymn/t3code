import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

// vercel/swr was renamed from zeit/swr; GitHub serves both names. Reads live GitHub through gh.
test(
  "A renamed repository's old and new names list each pull request once",
  WEB,
  async ({ t3, app, browser, screen }) => {
    for (const [title, origin] of [
      ["swr-old", "https://github.com/zeit/swr.git"],
      ["swr-new", "https://github.com/vercel/swr.git"],
    ] as const) {
      // `git init` keeps an existing config, so the project is added with its remote in place.
      await t3.project(title, { ".git/config": `[remote "origin"]\n\turl = ${origin}\n` });
    }
    await t3.open("/pull-requests?involvement=all&state=open&sort=updated");

    await expect(screen.getByText("Load more pull requests")).toBeVisible({ timeout: 120_000 });
    await app.screenshot("first-page");
    await screen.getByText("Load more pull requests").tap();
    const older = screen.getByText("#2067", { exact: false }).first();
    await expect(older).toBeVisible({ timeout: 120_000 });
    await older.scrollIntoView();
    await app.screenshot("after-load-more");

    // Rows render near the viewport only, so count the two the second page lists under both names.
    const rows = await browser.evaluate(() =>
      ["#2067", "#2103"].map(
        (number) =>
          [...document.querySelectorAll("[data-pull-request-key]")].filter((row) =>
            new RegExp(`${number}(?!\\d)`).test(row.textContent ?? ""),
          ).length,
      ),
    );
    expect(rows).toEqual([1, 1]);
  },
);
