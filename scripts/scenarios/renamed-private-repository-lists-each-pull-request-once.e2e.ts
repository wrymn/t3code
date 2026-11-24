import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

// wrymn/Hellforged (private) was renamed from wrymn/Solus. Reads live GitHub through gh.
test(
  "A renamed private repository's old and new names list each pull request once",
  WEB,
  async ({ t3, app, browser, screen }) => {
    for (const [title, origin] of [
      ["Solus", "https://github.com/wrymn/Solus.git"],
      ["Hellforged", "https://github.com/wrymn/Hellforged.git"],
    ] as const) {
      // `git init` keeps an existing config, so the project is added with its remote in place.
      await t3.project(title, { ".git/config": `[remote "origin"]\n\turl = ${origin}\n` });
    }
    await t3.open("/pull-requests?involvement=all&state=open&sort=updated");

    await expect(screen.getByText("wrymn/", { exact: false }).first()).toBeVisible({
      timeout: 120_000,
    });
    await app.screenshot("pull-requests");

    const numbers = await browser.evaluate(() =>
      [...document.querySelectorAll("[data-pull-request-key]")].map(
        (row) => row.textContent?.match(/#(\d+)/)?.[1] ?? "",
      ),
    );
    expect(numbers.length).toBeGreaterThan(0);
    expect(numbers.filter((number, index) => numbers.indexOf(number) !== index)).toEqual([]);
  },
);
