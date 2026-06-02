import { describe, it, expect } from "vitest";
import { extractCssVarsFromHtml, extractComponentHtml, isUsableCssVarValue } from "./themeTokenExtractor.server";

const SAMPLE_HTML = `
<html>
<head>
<style>
:root {
  --color-button: #1a1a1a;
  --color-button-text: #ffffff;
  --font-body-family: 'Helvetica Neue', sans-serif;
  --buttons--border-radius: 0px;
}
body { color: red; }
</style>
</head>
<body>
  <button type="submit" class="button button--primary button--full-width">Add to cart</button>
  <h1 class="h1">Product Title</h1>
  <div class="card card--standard">Card</div>
</body>
</html>
`;

const NO_VARS_HTML = `<html><body><p>No styles here</p></body></html>`;

describe("extractCssVarsFromHtml", () => {
  it("extracts all :root CSS custom properties", () => {
    const vars = extractCssVarsFromHtml(SAMPLE_HTML);
    expect(vars["--color-button"]).toBe("#1a1a1a");
    expect(vars["--color-button-text"]).toBe("#ffffff");
    expect(vars["--font-body-family"]).toBe("'Helvetica Neue', sans-serif");
    expect(vars["--buttons--border-radius"]).toBe("0px");
  });

  it("does not include non-custom-property declarations", () => {
    const vars = extractCssVarsFromHtml(SAMPLE_HTML);
    expect(Object.keys(vars).every(k => k.startsWith("--"))).toBe(true);
  });

  it("returns empty object when no CSS vars present", () => {
    const vars = extractCssVarsFromHtml(NO_VARS_HTML);
    expect(vars).toEqual({});
  });

  it("later declaration wins when same var declared twice", () => {
    const html = `<style>:root { --color-button: #first; } :root { --color-button: #second; }</style>`;
    const vars = extractCssVarsFromHtml(html);
    expect(vars["--color-button"]).toBe("#second");
  });

  it("drops malformed bare-unit values from empty theme settings", () => {
    // e.g. `--media-padding: {{ settings.padding }}px;` with an empty setting
    const html = `<style>:root { --media-padding: px; --inputs-radius: 2px; --x: rem; }</style>`;
    const vars = extractCssVarsFromHtml(html);
    expect(vars["--media-padding"]).toBeUndefined();
    expect(vars["--x"]).toBeUndefined();
    expect(vars["--inputs-radius"]).toBe("2px"); // real value kept
  });

  it("keeps legitimate RGB-triplet and scale values", () => {
    const html = `<style>:root { --color-base-text: 0, 0, 0; --font-body-scale: 1.0; --page-width: 160rem; }</style>`;
    const vars = extractCssVarsFromHtml(html);
    expect(vars["--color-base-text"]).toBe("0, 0, 0");
    expect(vars["--font-body-scale"]).toBe("1.0");
    expect(vars["--page-width"]).toBe("160rem");
  });
  // Note: un-rendered Liquid (`{{ }}` / `{% %}`) drop is covered directly in the
  // isUsableCssVarValue suite below — it can't be tested via the :root block
  // matcher because Liquid braces break the `[^}]+` block-capture regex.
});

describe("isUsableCssVarValue", () => {
  it("rejects empty, bare-unit, and Liquid values", () => {
    expect(isUsableCssVarValue("")).toBe(false);
    expect(isUsableCssVarValue("  ")).toBe(false);
    expect(isUsableCssVarValue("px")).toBe(false);
    expect(isUsableCssVarValue("REM")).toBe(false);
    expect(isUsableCssVarValue("{{ x }}")).toBe(false);
  });

  it("accepts real values", () => {
    expect(isUsableCssVarValue("4px")).toBe(true);
    expect(isUsableCssVarValue("0, 0, 0")).toBe(true);
    expect(isUsableCssVarValue("#1a1a1a")).toBe(true);
    expect(isUsableCssVarValue("'Helvetica Neue', sans-serif")).toBe(true);
  });
});

describe("extractComponentHtml", () => {
  it("extracts button--primary element", () => {
    const components = extractComponentHtml(SAMPLE_HTML);
    expect(components.button).toContain("button--primary");
  });

  it("extracts h1 as heading", () => {
    const components = extractComponentHtml(SAMPLE_HTML);
    expect(components.heading).toContain("<h1");
  });

  it("extracts card element", () => {
    const components = extractComponentHtml(SAMPLE_HTML);
    expect(components.card).toContain("card");
  });

  it("returns empty object when no components found", () => {
    const components = extractComponentHtml(NO_VARS_HTML);
    expect(components).toEqual({});
  });

  it("trims component HTML to 500 chars max", () => {
    const longAttr = "x".repeat(1000);
    const html = `<button class="button--primary" data-long="${longAttr}">Click</button>`;
    const components = extractComponentHtml(html);
    expect((components.button ?? "").length).toBeLessThanOrEqual(500);
  });
});
