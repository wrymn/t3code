import { getFiletypeFromFileName } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import { getSyntaxHighlighterPromise } from "./syntaxHighlighting";
import { DIFF_THEME_NAMES } from "./diffRendering";

it.each(["csharp", "cpp", "typescript"])(
  "uses Visual Assist Dark syntax colors in %s",
  async (language) => {
    const highlighter = await getSyntaxHighlighterPromise(language);
    const code = '// comment\nreturn "hello";\nreturn 42;';
    const { tokens } = highlighter.codeToTokens(code, {
      lang: language,
      theme: DIFF_THEME_NAMES.dark,
    });
    const colorOf = (text: string) =>
      tokens
        .flat()
        .find((token) => token.content.includes(text))
        ?.color?.toLowerCase();
    expect(colorOf("// comment")).toBe("#57a64a");
    expect(colorOf("return")).toBe("#d8a0df");
    expect(colorOf("hello")).toBe("#d69d85");
    expect(colorOf("42")).toBe("#b5cea8");
  },
);

describe("dialect file types", () => {
  it.each([
    ["src/init.luau", "lua"],
    ["styles/page.xsl", "xml"],
    ["styles/page.xslt", "xml"],
  ])("%s highlights as %s", (path, language) => {
    expect(getFiletypeFromFileName(path)).toBe(language);
  });
});

it.each([
  "asm",
  "assembly",
  "s",
  ...["asm", "ASM", "s", "S", "nasm", "NASM"].map((ext) => `src/start.${ext}`),
])("highlights assembly in %s", async (hint) => {
  const language = hint.includes("/") ? getFiletypeFromFileName(hint) : hint;
  const highlighter = await getSyntaxHighlighterPromise(language);
  const code = "mov eax, 42 ; answer\nret";
  for (const theme of Object.values(DIFF_THEME_NAMES)) {
    const { tokens } = highlighter.codeToTokens(code, { lang: language, theme });
    expect(tokens.map((line) => line.map((token) => token.content).join("")).join("\n")).toBe(code);
    expect(new Set(tokens.flat().map((token) => token.color)).size).toBeGreaterThan(1);
  }
});
