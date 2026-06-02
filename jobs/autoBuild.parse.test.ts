import { describe, it, expect } from "vitest";
import { parsePatchesJson } from "./autoBuild";

describe("parsePatchesJson", () => {
  it("parses strict JSON normally", () => {
    const r = parsePatchesJson<{ a: string }>('{"a":"hi"}');
    expect(r.a).toBe("hi");
  });

  it("recovers JSON with RAW newlines inside string values (Claude multi-line CSS)", () => {
    const broken = '{\n  "cssPatch": "\n#cro {\n  display: none;\n}\n",\n  "jsPatch": null\n}';
    const r = parsePatchesJson<{ cssPatch: string; jsPatch: null }>(broken);
    expect(r.cssPatch).toContain("#cro");
    expect(r.cssPatch).toContain("display: none");
    expect(r.jsPatch).toBeNull();
  });

  it("recovers raw tabs inside strings", () => {
    const broken = '{"x":"a\tb"}';
    expect(parsePatchesJson<{ x: string }>(broken).x).toBe("a\tb");
  });

  it("does not corrupt already-escaped sequences", () => {
    const ok = '{"x":"line1\\nline2"}';
    expect(parsePatchesJson<{ x: string }>(ok).x).toBe("line1\nline2");
  });
});
