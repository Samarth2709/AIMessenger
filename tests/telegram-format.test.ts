import { describe, expect, it } from "vitest";
import { formatTelegramText } from "../src/telegram-format.js";

describe("formatTelegramText", () => {
  it("escapes model HTML while rendering supported Markdown", () => {
    expect(
      formatTelegramText("**Status:** [Open docs](https://example.com/?a=1&b=2) <unsafe> `x < y`"),
    ).toBe(
      '<b>Status:</b> <a href="https://example.com/?a=1&amp;b=2">Open docs</a> &lt;unsafe&gt; <code>x &lt; y</code>',
    );
  });

  it("keeps unsupported links as escaped plain text", () => {
    expect(formatTelegramText("[local](file:///private/file)")).toBe(
      "[local](file:///private/file)",
    );
  });
});
