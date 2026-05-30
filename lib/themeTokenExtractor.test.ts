import { describe, it, expect } from "vitest";
import { extractCssVarsFromHtml, extractComponentHtml } from "./themeTokenExtractor.server";

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
