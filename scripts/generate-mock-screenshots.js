/**
 * Shivook AI CRO — Mock App Store screenshot generator
 * Run: node scripts/generate-mock-screenshots.js
 *
 * Generates 4 polished screenshots with realistic 3-4 month store data.
 * Output: /tmp/app_store_screenshots/mock_*.png
 */

import { chromium } from "@playwright/test";
import fs from "fs";
import path from "path";

const OUT = "/tmp/app_store_screenshots";
fs.mkdirSync(OUT, { recursive: true });

// ── shared styles ─────────────────────────────────────────────────────────────

const BASE_CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 14px;
    background: #f1f2f4;
    color: #202223;
    line-height: 1.5;
    padding: 24px;
  }
  .card {
    background: #fff;
    border-radius: 12px;
    box-shadow: 0 0 0 1px rgba(0,0,0,.08), 0 1px 3px rgba(0,0,0,.06);
    margin-bottom: 16px;
    overflow: hidden;
  }
  .card-header {
    padding: 16px 20px;
    border-bottom: 1px solid #f1f2f4;
    font-weight: 600;
    font-size: 14px;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .badge {
    display: inline-flex;
    align-items: center;
    padding: 2px 10px;
    border-radius: 20px;
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
  }
  .badge-active   { background:#aee9d1; color:#0d7a5f; }
  .badge-draft    { background:#e4e5e7; color:#6d7175; }
  .badge-concluded{ background:#e4e5e7; color:#3a3c3f; }
  .badge-pending  { background:#ffd79d; color:#7a4f00; }
  .badge-qa       { background:#ffd2d2; color:#8c1d18; }
  .badge-build    { background:#aee9d1; color:#0d7a5f; }
  .badge-ship     { background:#aee9d1; color:#0d7a5f; }
  .badge-decide   { background:#aee9d1; color:#0d7a5f; }
  .badge-monitor  { background:#a4e8f2; color:#0a5f6b; }
  .badge-hypothesis { background:#e0d7ff; color:#4b3bac; }
  .badge-research { background:#e4e5e7; color:#6d7175; }
  .badge-activate { background:#ffd79d; color:#7a4f00; }
  .text-subdued { color: #6d7175; }
  .text-link { color: #005bd3; text-decoration: none; }
  .text-link:hover { text-decoration: underline; }
  .page-title {
    font-size: 20px;
    font-weight: 650;
    margin-bottom: 16px;
    color: #202223;
  }
  table { width: 100%; border-collapse: collapse; }
  th {
    text-align: left;
    padding: 10px 16px;
    font-size: 12px;
    font-weight: 600;
    color: #6d7175;
    border-bottom: 1px solid #f1f2f4;
    white-space: nowrap;
  }
  td {
    padding: 12px 16px;
    border-bottom: 1px solid #f8f8f8;
    vertical-align: middle;
    font-size: 13px;
  }
  tr:last-child td { border-bottom: none; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .winner-lift { color: #0d7a5f; font-weight: 600; }
  .loser-lift  { color: #c23b22; font-weight: 600; }
  .btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 7px 14px; border-radius: 8px; font-size: 13px;
    font-weight: 500; cursor: pointer; border: none;
  }
  .btn-primary { background:#303030; color:#fff; }
  .btn-secondary { background:#fff; color:#303030; border: 1px solid #c9cccf; }
  .ice-bar {
    display: flex; gap: 4px; align-items: center;
  }
  .ice-dot {
    width: 8px; height: 8px; border-radius: 50%;
  }
  .top-bar {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 20px;
  }
`;

// ── screenshot 1: experiments list ────────────────────────────────────────────

const SCREEN1 = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>${BASE_CSS}
  body { width: 1200px; }
</style></head><body>
<div class="top-bar">
  <div class="page-title">A/B Experiments</div>
  <button class="btn btn-primary">+ New experiment</button>
</div>

<div class="card">
  <table>
    <thead>
      <tr>
        <th>Name</th><th>Status</th><th>Page type</th>
        <th class="num">Visitors</th><th class="num">Control conv.</th>
        <th class="num">Treatment conv.</th><th class="num">Lift</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td><a class="text-link">Sticky Add-to-Cart on Product Pages</a></td>
        <td><span class="badge badge-concluded">concluded</span></td>
        <td>product</td>
        <td class="num">5,847</td><td class="num">3.20%</td>
        <td class="num">3.89%</td><td class="num winner-lift">+21.6%</td>
      </tr>
      <tr>
        <td><a class="text-link">Homepage Hero Social Proof Counter</a></td>
        <td><span class="badge badge-concluded">concluded</span></td>
        <td>homepage</td>
        <td class="num">4,203</td><td class="num">2.10%</td>
        <td class="num">2.43%</td><td class="num winner-lift">+15.7%</td>
      </tr>
      <tr>
        <td><a class="text-link">Free Shipping Threshold Banner</a></td>
        <td><span class="badge badge-concluded">concluded</span></td>
        <td>any</td>
        <td class="num">3,891</td><td class="num">2.80%</td>
        <td class="num">2.74%</td><td class="num loser-lift">−2.1%</td>
      </tr>
      <tr>
        <td><a class="text-link">Collection Page Grid vs List Toggle</a></td>
        <td><span class="badge badge-concluded">concluded</span></td>
        <td>collection</td>
        <td class="num">2,654</td><td class="num">4.10%</td>
        <td class="num">4.08%</td><td class="num text-subdued">−0.5%</td>
      </tr>
      <tr>
        <td><a class="text-link">Product Image Zoom on Hover</a></td>
        <td><span class="badge badge-active">active</span></td>
        <td>product</td>
        <td class="num">1,234</td><td class="num">2.90%</td>
        <td class="num">3.41%</td><td class="num winner-lift">+17.6%</td>
      </tr>
      <tr>
        <td><a class="text-link">Urgency Timer on Cart Page</a></td>
        <td><span class="badge badge-active">active</span></td>
        <td>cart</td>
        <td class="num">892</td><td class="num">6.80%</td>
        <td class="num">7.12%</td><td class="num winner-lift">+4.7%</td>
      </tr>
      <tr>
        <td><a class="text-link">Mobile CTA Colour Contrast</a></td>
        <td><span class="badge badge-active">active</span></td>
        <td>product</td>
        <td class="num">643</td><td class="num">3.10%</td>
        <td class="num">3.09%</td><td class="num text-subdued">−0.3%</td>
      </tr>
      <tr>
        <td><a class="text-link">Exit Intent Popup Copy Test</a></td>
        <td><span class="badge badge-draft">draft</span></td>
        <td>any</td>
        <td class="num">—</td><td class="num">—</td>
        <td class="num">—</td><td class="num">—</td>
      </tr>
      <tr>
        <td><a class="text-link">Bundle Upsell Placement</a></td>
        <td><span class="badge badge-draft">draft</span></td>
        <td>product</td>
        <td class="num">—</td><td class="num">—</td>
        <td class="num">—</td><td class="num">—</td>
      </tr>
    </tbody>
  </table>
</div>

<div class="card">
  <div class="card-header">AI Orchestrator Activity</div>
  <div style="padding:8px 0;">
    ${[
      ["RESEARCH","complete","2h ago","run 4a9f2c1b"],
      ["HYPOTHESIS","complete","2h ago","run 4a9f2c1b"],
      ["BUILD","complete","2h ago","run 4a9f2c1b"],
      ["QA","complete","2h ago","run 4a9f2c1b"],
      ["MONITOR","complete","2h ago","run 4a9f2c1b"],
      ["DECIDE","complete","2h ago","run 4a9f2c1b"],
      ["SHIP","complete","2h ago","run 4a9f2c1b"],
    ].map(([stage,status,time,run]) => `
      <div style="display:flex;align-items:center;gap:12px;padding:10px 20px;border-bottom:1px solid #f8f8f8;">
        <span class="badge badge-${stage.toLowerCase()}">${stage}</span>
        <span class="badge badge-${status === 'complete' ? 'build' : 'qa'}" style="font-size:11px;">${status}</span>
        <span class="text-subdued" style="font-size:12px;">${time} — ${run}</span>
      </div>`).join("")}
  </div>
</div>
</body></html>`;

// ── screenshot 2: AI hypotheses ───────────────────────────────────────────────

const HYPOTHESES = [
  { title:"Persistent Size Guide Reduces Friction", page:"product", el:"trust", impact:9, conf:8, ease:10, score:720, status:"backlog" },
  { title:"Video Background Increases Engagement", page:"homepage", el:"image", impact:9, conf:7, ease:10, score:630, status:"backlog" },
  { title:"Cart Abandonment Recovery Modal", page:"cart", el:"cta", impact:8, conf:7, ease:10, score:560, status:"backlog" },
  { title:"Product Bundle Discount Visibility", page:"product", el:"price", impact:7, conf:8, ease:9, score:504, status:"backlog" },
  { title:"Mobile Navigation Simplification", page:"any", el:"layout", impact:8, conf:6, ease:10, score:480, status:"backlog" },
  { title:"Trust Badges Below Add to Cart", page:"product", el:"trust", impact:6, conf:8, ease:9, score:432, status:"promoted" },
  { title:"Collection Default Sort Optimisation", page:"collection", el:"layout", impact:6, conf:6, ease:10, score:360, status:"backlog" },
  { title:"Social Proof Notification Bar", page:"any", el:"trust", impact:7, conf:5, ease:9, score:315, status:"backlog" },
  { title:"Product Description Benefit-Led Format", page:"product", el:"headline", impact:5, conf:7, ease:9, score:315, status:"rejected" },
  { title:"Sticky Header Cart Icon Counter", page:"any", el:"layout", impact:5, conf:6, ease:8, score:240, status:"backlog" },
];

const SCREEN2 = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>${BASE_CSS}
  body { width: 1200px; }
  .hyp-row {
    display: flex; align-items: flex-start; gap: 16px;
    padding: 16px 20px; border-bottom: 1px solid #f1f2f4;
  }
  .hyp-row:last-child { border-bottom: none; }
  .hyp-title { font-weight: 500; font-size: 13px; margin-bottom: 4px; }
  .hyp-meta { font-size: 12px; color: #6d7175; display:flex; gap:12px; }
  .ice-block {
    display:flex; gap:6px; align-items:center;
    background:#f6f6f7; border-radius:8px; padding:6px 10px;
    flex-shrink:0; min-width:160px;
  }
  .ice-item { text-align:center; }
  .ice-label { font-size:10px; color:#6d7175; }
  .ice-value { font-size:14px; font-weight:600; }
  .ice-score { font-size:18px; font-weight:700; color:#005bd3; }
  .actions { display:flex; gap:6px; margin-left:auto; flex-shrink:0; align-self:center; }
  .badge-promoted { background:#c9f0d8; color:#0d7a5f; }
  .badge-rejected { background:#ffd2d2; color:#8c1d18; }
  .badge-backlog  { background:#e0d7ff; color:#4b3bac; }
</style></head><body>
<div class="top-bar">
  <div class="page-title">AI Hypotheses</div>
  <button class="btn btn-primary">Generate new hypotheses</button>
</div>

<div class="card" style="margin-bottom:16px; padding:14px 20px; display:flex; align-items:center; gap:12px; background:#f0f7ff; border:1px solid #b3d4f5;">
  <span style="font-size:18px;">✦</span>
  <div>
    <div style="font-weight:600; font-size:13px;">Last research run: 2 hours ago</div>
    <div style="font-size:12px; color:#6d7175;">14 new hypotheses generated from Shopify + GA4 + Clarity data. Next run in 22 hours.</div>
  </div>
</div>

<div class="card">
  <div class="card-header">
    Hypothesis Backlog
    <span style="font-size:12px; font-weight:400; color:#6d7175;">Sorted by ICE score</span>
  </div>
  ${HYPOTHESES.map(h => `
  <div class="hyp-row">
    <div style="flex:1; min-width:0;">
      <div class="hyp-title">${h.title}</div>
      <div class="hyp-meta">
        <span>${h.page}</span>
        <span>${h.el}</span>
      </div>
    </div>
    <div class="ice-block">
      <div class="ice-item"><div class="ice-label">Impact</div><div class="ice-value">${h.impact}</div></div>
      <div style="color:#e4e5e7">·</div>
      <div class="ice-item"><div class="ice-label">Confidence</div><div class="ice-value">${h.conf}</div></div>
      <div style="color:#e4e5e7">·</div>
      <div class="ice-item"><div class="ice-label">Ease</div><div class="ice-value">${h.ease}</div></div>
      <div style="width:1px;background:#e4e5e7;margin:0 4px;"></div>
      <div class="ice-item"><div class="ice-label">Score</div><div class="ice-score">${h.score}</div></div>
    </div>
    <span class="badge badge-${h.status}" style="flex-shrink:0;">${h.status}</span>
    <div class="actions">
      ${h.status === 'backlog' ? `<button class="btn btn-primary" style="font-size:12px;padding:5px 10px;">Promote</button><button class="btn btn-secondary" style="font-size:12px;padding:5px 10px;">Reject</button>` : ''}
    </div>
  </div>`).join("")}
</div>
</body></html>`;

// ── screenshot 3: experiment detail with results ───────────────────────────────

const SCREEN3 = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>${BASE_CSS}
  body { width: 1200px; }
  .grid2 { display:grid; grid-template-columns:1fr 340px; gap:16px; }
  .stat-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:1px; background:#f1f2f4; }
  .stat-cell { background:#fff; padding:16px 20px; }
  .stat-label { font-size:11px; color:#6d7175; text-transform:uppercase; letter-spacing:.5px; margin-bottom:4px; }
  .stat-value { font-size:22px; font-weight:700; }
  .stat-sub   { font-size:12px; color:#6d7175; margin-top:2px; }
  .prob-gauge {
    width:100%; aspect-ratio:2/1; position:relative;
    display:flex; align-items:center; justify-content:center;
  }
  .bar-chart { display:flex; align-items:flex-end; gap:20px; height:120px; padding:0 20px; }
  .bar-group { display:flex; flex-direction:column; align-items:center; gap:4px; flex:1; }
  .bar { width:100%; border-radius:4px 4px 0 0; }
  .bar-label { font-size:11px; color:#6d7175; }
  .bar-value { font-size:12px; font-weight:600; }
  .winner-banner {
    background:linear-gradient(135deg,#e6f9f0,#c9f0d8);
    border:1px solid #7ed8b0; border-radius:10px;
    padding:16px 20px; margin-bottom:16px;
    display:flex; align-items:center; gap:12px;
  }
</style></head><body>

<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;">
  <a class="text-link" style="font-size:13px;">All experiments</a>
  <span class="text-subdued">›</span>
  <span style="font-size:13px;">Sticky Add-to-Cart on Product Pages</span>
</div>
<div class="top-bar" style="margin-top:8px;">
  <div class="page-title">Sticky Add-to-Cart on Product Pages</div>
  <span class="badge badge-concluded" style="font-size:13px;padding:4px 14px;">concluded</span>
</div>

<div class="winner-banner">
  <span style="font-size:24px;">🏆</span>
  <div>
    <div style="font-weight:700;font-size:14px;color:#0d7a5f;">Winner declared — Treatment</div>
    <div style="font-size:12px;color:#215732;margin-top:2px;">97.3% probability to beat control · +21.6% conversion lift · Ran 18 days</div>
  </div>
</div>

<div class="grid2">
  <div>
    <div class="card">
      <div class="card-header">Results</div>
      <div class="stat-grid">
        <div class="stat-cell">
          <div class="stat-label">Total visitors</div>
          <div class="stat-value">5,847</div>
          <div class="stat-sub">18 days</div>
        </div>
        <div class="stat-cell">
          <div class="stat-label">Control conv.</div>
          <div class="stat-value">3.20%</div>
          <div class="stat-sub">94 / 2,924</div>
        </div>
        <div class="stat-cell">
          <div class="stat-label">Treatment conv.</div>
          <div class="stat-value" style="color:#0d7a5f">3.89%</div>
          <div class="stat-sub">114 / 2,923</div>
        </div>
        <div class="stat-cell">
          <div class="stat-label">Relative lift</div>
          <div class="stat-value winner-lift">+21.6%</div>
          <div class="stat-sub">95% CI: +8.1% – +35.2%</div>
        </div>
      </div>

      <div style="padding:20px;">
        <div style="font-size:13px;font-weight:600;margin-bottom:16px;">Probability to beat control</div>
        <!-- SVG gauge -->
        <svg viewBox="0 0 300 160" width="300" style="display:block;margin:0 auto 8px;">
          <!-- background arc -->
          <path d="M 30 140 A 120 120 0 0 1 270 140" fill="none" stroke="#e4e5e7" stroke-width="18" stroke-linecap="round"/>
          <!-- filled arc (97.3% = ~175deg of 180) -->
          <path d="M 30 140 A 120 120 0 0 1 267 148" fill="none" stroke="#0d7a5f" stroke-width="18" stroke-linecap="round"/>
          <!-- 95% threshold line -->
          <line x1="238" y1="87" x2="250" y2="75" stroke="#ff6b35" stroke-width="2" stroke-dasharray="4"/>
          <text x="252" y="72" font-size="10" fill="#ff6b35">95% threshold</text>
          <!-- center text -->
          <text x="150" y="118" text-anchor="middle" font-size="36" font-weight="700" fill="#0d7a5f">97.3%</text>
          <text x="150" y="138" text-anchor="middle" font-size="12" fill="#6d7175">probability to beat control</text>
        </svg>

        <div style="display:flex;gap:16px;margin-top:20px;">
          <div style="flex:1;">
            <div style="font-size:11px;color:#6d7175;margin-bottom:6px;font-weight:600;">CONVERSION RATE</div>
            <div style="display:flex;align-items:flex-end;gap:12px;height:80px;">
              <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;">
                <div style="font-size:12px;font-weight:600;">3.20%</div>
                <div style="width:100%;height:52px;background:#e4e5e7;border-radius:4px 4px 0 0;"></div>
                <div style="font-size:11px;color:#6d7175;">Control</div>
              </div>
              <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;">
                <div style="font-size:12px;font-weight:600;color:#0d7a5f;">3.89%</div>
                <div style="width:100%;height:63px;background:#0d7a5f;border-radius:4px 4px 0 0;"></div>
                <div style="font-size:11px;color:#6d7175;">Treatment</div>
              </div>
            </div>
          </div>
          <div style="flex:1;">
            <div style="font-size:11px;color:#6d7175;margin-bottom:6px;font-weight:600;">DAILY VISITORS (7-DAY TREND)</div>
            <svg viewBox="0 0 180 80" width="100%">
              <polyline points="0,60 30,52 60,48 90,44 120,38 150,30 180,24"
                fill="none" stroke="#005bd3" stroke-width="2" stroke-linejoin="round"/>
              <polyline points="0,60 30,52 60,48 90,44 120,38 150,30 180,24 180,80 0,80"
                fill="#e8f0fe" stroke="none"/>
            </svg>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-header">Ship the winner</div>
      <div style="padding:16px 20px;">
        <div style="font-size:13px;color:#6d7175;margin-bottom:12px;">
          To make this variant permanent, add the code below to your theme. It has been pre-validated and is production-ready.
        </div>
        <div style="background:#1a1a1a;border-radius:8px;padding:14px;font-family:monospace;font-size:12px;color:#aee9d1;margin-bottom:8px;line-height:1.7;">
          <span style="color:#6d7175;">// Sticky ATC — inject after DOMContentLoaded</span><br>
          document.addEventListener('DOMContentLoaded', () => {<br>
          &nbsp;&nbsp;const atc = document.querySelector('.product-form__submit');<br>
          &nbsp;&nbsp;if (!atc) return;<br>
          &nbsp;&nbsp;const sticky = atc.cloneNode(true);<br>
          &nbsp;&nbsp;sticky.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:999;';<br>
          &nbsp;&nbsp;document.body.appendChild(sticky);<br>
          });
        </div>
        <button class="btn btn-secondary" style="font-size:12px;">Copy JS patch ↗</button>
      </div>
    </div>
  </div>

  <div>
    <div class="card">
      <div class="card-header">Details</div>
      <div style="padding:4px 0;">
        ${[
          ["Page type","product"],
          ["Element","cta"],
          ["Target metric","conversion_rate"],
          ["Traffic split","50 / 50"],
          ["Started","Mar 8, 2026"],
          ["Concluded","Mar 26, 2026"],
          ["Duration","18 days"],
          ["Segment","Mobile visitors"],
        ].map(([k,v]) => `
          <div style="display:flex;justify-content:space-between;padding:10px 16px;border-bottom:1px solid #f8f8f8;font-size:13px;">
            <span class="text-subdued">${k}</span>
            <span style="font-weight:500;">${v}</span>
          </div>`).join("")}
      </div>
    </div>

    <div class="card">
      <div class="card-header">Hypothesis</div>
      <div style="padding:14px 16px;font-size:13px;line-height:1.6;color:#3a3c3f;">
        We believe adding a sticky add-to-cart button on product pages will increase
        conversion rate because it removes friction for mobile users who scroll past
        the primary CTA and lose access to it.
      </div>
    </div>

    <div class="card">
      <div class="card-header">Knowledge base</div>
      <div style="padding:14px 16px;font-size:13px;color:#6d7175;">
        ✓ Result saved to knowledge base. The AI will use this to inform future
        hypothesis generation on product pages.
      </div>
    </div>
  </div>
</div>
</body></html>`;

// ── screenshot 4: home dashboard ──────────────────────────────────────────────

const SCREEN4 = `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>${BASE_CSS}
  body { width: 1200px; }
  .kpi-grid { display:grid; grid-template-columns:repeat(4,1fr); gap:16px; margin-bottom:16px; }
  .kpi-card { background:#fff; border-radius:12px; box-shadow:0 0 0 1px rgba(0,0,0,.08); padding:16px 20px; }
  .kpi-label { font-size:12px; color:#6d7175; margin-bottom:6px; }
  .kpi-value { font-size:26px; font-weight:700; }
  .kpi-sub   { font-size:12px; color:#0d7a5f; margin-top:4px; }
</style></head><body>

<div class="page-title">Overview</div>

<div class="kpi-grid">
  <div class="kpi-card">
    <div class="kpi-label">Active experiments</div>
    <div class="kpi-value">3</div>
    <div class="kpi-sub">↑ 1 from last week</div>
  </div>
  <div class="kpi-card">
    <div class="kpi-label">Total experiments</div>
    <div class="kpi-value">9</div>
    <div class="kpi-sub">4 concluded</div>
  </div>
  <div class="kpi-card">
    <div class="kpi-label">Win rate</div>
    <div class="kpi-value">62.5%</div>
    <div class="kpi-sub">5 of 8 concluded tests</div>
  </div>
  <div class="kpi-card">
    <div class="kpi-label">Avg. conversion lift</div>
    <div class="kpi-value">+14.2%</div>
    <div class="kpi-sub">Across winning tests</div>
  </div>
</div>

<div class="card" style="margin-bottom:16px;">
  <div class="card-header">Active experiments</div>
  <table>
    <thead>
      <tr>
        <th>Name</th><th>Status</th><th>Page type</th>
        <th class="num">Visitors</th><th class="num">Control conv.</th>
        <th class="num">Treatment conv.</th><th class="num">Prob. to beat</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td><a class="text-link">Product Image Zoom on Hover</a></td>
        <td><span class="badge badge-active">active</span></td>
        <td>product</td>
        <td class="num">1,234</td><td class="num">2.90%</td>
        <td class="num">3.41%</td><td class="num" style="color:#0d7a5f;font-weight:600;">71.4%</td>
      </tr>
      <tr>
        <td><a class="text-link">Urgency Timer on Cart Page</a></td>
        <td><span class="badge badge-active">active</span></td>
        <td>cart</td>
        <td class="num">892</td><td class="num">6.80%</td>
        <td class="num">7.12%</td><td class="num" style="color:#6d7175;">58.2%</td>
      </tr>
      <tr>
        <td><a class="text-link">Mobile CTA Colour Contrast</a></td>
        <td><span class="badge badge-active">active</span></td>
        <td>product</td>
        <td class="num">643</td><td class="num">3.10%</td>
        <td class="num">3.09%</td><td class="num" style="color:#6d7175;">47.8%</td>
      </tr>
    </tbody>
  </table>
</div>

<div class="card">
  <div class="card-header">AI Orchestrator Activity</div>
  <div style="padding:8px 0;">
    ${[
      ["RESEARCH","complete","2h ago","run 4a9f2c1b"],
      ["HYPOTHESIS","complete","2h ago","run 4a9f2c1b"],
      ["BUILD","complete","2h ago","run 4a9f2c1b"],
      ["QA","complete","2h ago","run 4a9f2c1b"],
      ["MONITOR","complete","2h ago","run 4a9f2c1b"],
      ["DECIDE","complete","2h ago","run 4a9f2c1b"],
      ["SHIP","complete","2h ago","run 4a9f2c1b"],
      ["RESEARCH","complete","8h ago","run 88af7795"],
      ["HYPOTHESIS","complete","8h ago","run 88af7795"],
      ["BUILD","complete","8h ago","run 88af7795"],
      ["QA","complete","8h ago","run 88af7795"],
      ["MONITOR","complete","8h ago","run 88af7795"],
      ["DECIDE","complete","8h ago","run 88af7795"],
      ["SHIP","complete","8h ago","run 88af7795"],
    ].map(([stage,status,time,run]) => `
      <div style="display:flex;align-items:center;gap:12px;padding:9px 20px;border-bottom:1px solid #f8f8f8;">
        <span class="badge badge-${stage.toLowerCase()}" style="min-width:88px;justify-content:center;">${stage}</span>
        <span class="badge badge-build" style="font-size:11px;">${status}</span>
        <span class="text-subdued" style="font-size:12px;">${time} — ${run}</span>
      </div>`).join("")}
  </div>
</div>
</body></html>`;

// ── render ────────────────────────────────────────────────────────────────────

async function render(browser, html, filename) {
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1300, height: 900 });
  await page.setContent(html, { waitUntil: "networkidle" });
  // Auto-fit height
  const height = await page.evaluate(() => document.body.scrollHeight + 48);
  await page.setViewportSize({ width: 1300, height: Math.max(900, height) });
  const dest = path.join(OUT, filename);
  await page.screenshot({ path: dest, fullPage: true });
  console.log(`✓ ${filename} → ${dest}`);
  await page.close();
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  await render(browser, SCREEN1, "mock_01_experiments.png");
  await render(browser, SCREEN2, "mock_02_hypotheses.png");
  await render(browser, SCREEN3, "mock_03_results.png");
  await render(browser, SCREEN4, "mock_04_dashboard.png");
  await browser.close();
  console.log(`\nAll 4 screenshots saved to ${OUT}`);
}

main().catch(err => { console.error(err); process.exit(1); });
