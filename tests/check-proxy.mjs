import { chromium } from "playwright";
import * as fs from "fs";

const authState = JSON.parse(fs.readFileSync("tests/.storefront-auth.json", "utf-8"));

const b = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await b.newContext({ storageState: authState });
const page = await ctx.newPage();

const proxyResponses = [];
page.on("response", async (resp) => {
  const url = resp.url();
  if (url.includes("/apps/cro/")) {
    try {
      const body = await resp.text();
      proxyResponses.push({ url, status: resp.status(), body: body.slice(0, 500) });
    } catch { /* ignore */ }
  }
});

await page.goto("https://shivook-team.myshopify.com", {
  waitUntil: "networkidle",
  timeout: 30000,
});

console.log("\n=== App Proxy Responses ===");
if (proxyResponses.length === 0) {
  console.log("NO proxy requests made — App Proxy may not be active yet");
} else {
  proxyResponses.forEach(r => {
    console.log(`\n${r.status} ${r.url}`);
    console.log(r.body);
  });
}

// Also dump all localStorage
const ls = await page.evaluate(() => {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    out[k] = localStorage.getItem(k);
  }
  return out;
});
console.log("\n=== localStorage ===");
console.log(JSON.stringify(ls, null, 2));

await b.close();
