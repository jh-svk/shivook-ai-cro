# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: storefront.spec.ts >> JS patch runs and sets data-cro-variant on body
- Location: tests/e2e/storefront.spec.ts:144:1

# Error details

```
Test timeout of 60000ms exceeded.
```

```
Error: page.waitForFunction: Test timeout of 60000ms exceeded.
```

# Test source

```ts
  48  |       startedAt: new Date(),
  49  |       variants: {
  50  |         create: [
  51  |           {
  52  |             type: "control",
  53  |             name: "Control",
  54  |             description: "E2E control variant",
  55  |             // Writes a detectable marker to the page title so we can assert
  56  |             // the JS patch ran without needing to inspect the DOM deeply.
  57  |             jsPatch: `document.body.setAttribute("data-cro-variant", "control");`,
  58  |           },
  59  |           {
  60  |             type: "treatment",
  61  |             name: "Treatment",
  62  |             description: "E2E treatment variant",
  63  |             jsPatch: `document.body.setAttribute("data-cro-variant", "treatment");`,
  64  |           },
  65  |         ],
  66  |       },
  67  |     },
  68  |     include: { variants: true },
  69  |   });
  70  | 
  71  |   testExperimentId = experiment.id;
  72  |   controlVariantId = experiment.variants.find((v) => v.type === "control")!.id;
  73  |   treatmentVariantId = experiment.variants.find((v) => v.type === "treatment")!.id;
  74  | });
  75  | 
  76  | test.afterAll(async () => {
  77  |   if (prisma && testExperimentId) {
  78  |     await prisma.event.deleteMany({ where: { experimentId: testExperimentId } });
  79  |     await prisma.variant.deleteMany({ where: { experimentId: testExperimentId } });
  80  |     await prisma.experiment.delete({ where: { id: testExperimentId } });
  81  |   }
  82  |   await prisma?.$disconnect();
  83  | });
  84  | 
  85  | // ── Tests ────────────────────────────────────────────────────────────────────
  86  | 
  87  | test("theme extension injects #cro-injector-root with correct attributes", async ({
  88  |   page,
  89  | }) => {
  90  |   await page.goto(STORE_URL, { waitUntil: "domcontentloaded" });
  91  | 
  92  |   const root = page.locator("#cro-injector-root");
  93  |   await expect(root).toBeAttached({ timeout: 10_000 });
  94  | 
  95  |   await expect(root).toHaveAttribute("data-shop", SHOP_DOMAIN);
  96  |   // The Liquid block maps 'index' → 'homepage'
  97  |   await expect(root).toHaveAttribute("data-page-type", "homepage");
  98  | });
  99  | 
  100 | test("visitor ID is written to localStorage after injector runs", async ({
  101 |   page,
  102 | }) => {
  103 |   await page.goto(STORE_URL);
  104 | 
  105 |   // Wait until the injector script sets the visitor ID
  106 |   const visitorId = await page.waitForFunction(
  107 |     () => localStorage.getItem("cro_visitor_id"),
  108 |     { timeout: 15_000 }
  109 |   );
  110 | 
  111 |   expect(await visitorId.jsonValue()).toMatch(/^[0-9a-f-]{36}$/);
  112 | });
  113 | 
  114 | test("variant assignment is persisted in localStorage and is stable", async ({
  115 |   page,
  116 | }) => {
  117 |   await page.goto(STORE_URL);
  118 | 
  119 |   const assignmentKey = `cro_assign_${testExperimentId}`;
  120 | 
  121 |   const assignment = await page.waitForFunction(
  122 |     (key) => localStorage.getItem(key),
  123 |     assignmentKey,
  124 |     { timeout: 15_000 }
  125 |   );
  126 | 
  127 |   const value = await assignment.jsonValue();
  128 |   expect(["control", "treatment"]).toContain(value);
  129 | 
  130 |   // Second visit — same visitor should see the same variant
  131 |   await page.reload();
  132 |   await page.waitForFunction(
  133 |     (key) => localStorage.getItem(key),
  134 |     assignmentKey,
  135 |     { timeout: 15_000 }
  136 |   );
  137 |   const valueAfterReload = await page.evaluate(
  138 |     (key) => localStorage.getItem(key),
  139 |     assignmentKey
  140 |   );
  141 |   expect(valueAfterReload).toBe(value);
  142 | });
  143 | 
  144 | test("JS patch runs and sets data-cro-variant on body", async ({ page }) => {
  145 |   await page.goto(STORE_URL);
  146 | 
  147 |   // Wait for the injector to apply the patch
> 148 |   const variantAttr = await page.waitForFunction(
      |                                  ^ Error: page.waitForFunction: Test timeout of 60000ms exceeded.
  149 |     () => document.body.getAttribute("data-cro-variant"),
  150 |     { timeout: 15_000 }
  151 |   );
  152 | 
  153 |   expect(["control", "treatment"]).toContain(await variantAttr.jsonValue());
  154 | });
  155 | 
  156 | test("view event is recorded in the database within 15 seconds", async ({
  157 |   page,
  158 | }) => {
  159 |   // Clear prior events for a clean assertion
  160 |   await prisma.event.deleteMany({ where: { experimentId: testExperimentId } });
  161 | 
  162 |   await page.goto(STORE_URL);
  163 | 
  164 |   // Wait for localStorage assignment (proxy for injector having run)
  165 |   await page.waitForFunction(
  166 |     (key) => localStorage.getItem(key),
  167 |     `cro_assign_${testExperimentId}`,
  168 |     { timeout: 15_000 }
  169 |   );
  170 | 
  171 |   // Poll the database for up to 15 seconds
  172 |   let viewEvent = null;
  173 |   for (let attempt = 0; attempt < 15; attempt++) {
  174 |     await page.waitForTimeout(1000);
  175 |     viewEvent = await prisma.event.findFirst({
  176 |       where: { experimentId: testExperimentId, eventType: "view" },
  177 |     });
  178 |     if (viewEvent) break;
  179 |   }
  180 | 
  181 |   expect(viewEvent).not.toBeNull();
  182 |   expect(viewEvent!.eventType).toBe("view");
  183 |   expect(viewEvent!.visitorId).toMatch(/^[0-9a-f-]{36}$/);
  184 |   expect([controlVariantId, treatmentVariantId]).toContain(viewEvent!.variantId);
  185 |   expect(viewEvent!.experimentId).toBe(testExperimentId);
  186 | });
  187 | 
```