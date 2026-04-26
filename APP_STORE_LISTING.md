# App Store Listing — Shivook AI CRO

## App name
Shivook AI CRO

## Support email
support@shivook.com

## Tagline (under 100 chars)
The autonomous A/B testing engine that finds, builds, and ships winning variants for you.

## Short description (under 160 chars — shows in search results)
AI-powered CRO that generates hypotheses, builds variants, runs A/B tests, and ships winners — automatically.

## Long description (~400 words)

**Stop guessing. Start winning.**

Shivook AI CRO is the only Shopify app that runs your entire conversion optimisation program autonomously — from research to results, without lifting a finger.

### How it works

**1. AI Research**
Connect your Google Analytics 4 and Microsoft Clarity data. Every night, the AI analyses your store metrics — funnel drop-offs, rage clicks, scroll depth, add-to-cart rates — and produces a prioritised list of friction points ranked by conversion impact.

**2. Hypothesis Generation**
The AI generates 10–20 specific, testable A/B test hypotheses scored by ICE (Impact × Confidence × Ease). Review the backlog and promote what you like, or let the autonomous loop do it all.

**3. Auto-Build Variants**
On the Pro plan, the orchestrator picks the highest-scoring hypothesis, calls Claude AI to write the HTML/CSS/JS variant, runs a performance QA gate (no synchronous scripts, under 10kb), and creates the experiment automatically.

**4. Variant Injection**
Variants are injected via a Shopify Theme App Extension — no Liquid edits required. The injector runs asynchronously (zero impact on LCP), assigns visitors to control or treatment using a stable hash, and fires conversion events via the Shopify Web Pixel.

**5. Bayesian Results**
Results are computed hourly using Bayesian statistics. Instead of a p-value, you see "Probability to beat control." At 95%, the experiment is flagged as a winner. The guardrail system monitors AOV — if it drops more than 3%, the experiment is concluded immediately.

**6. Audience Segmentation**
Target experiments at specific visitor segments: mobile vs desktop, paid traffic vs organic, new visitors vs returning customers, specific hours of the day, and more.

### Plans
- **Starter** ($39/month) — Up to 5 manual A/B tests
- **Growth** ($99/month) — Up to 10 tests + AI hypothesis generation
- **Pro** ($199/month) — Up to 20 tests + full autonomous loop, auto-build, segmentation

All plans include a 14-day free trial.

---

## Key features

- AI generates ranked A/B test hypotheses from your store data every night
- Autonomous experiment lifecycle: research → build → test → decide → ship
- Bayesian statistics (probability to beat control, not p-values)
- Audience segmentation by device, traffic source, visitor type, and time of day
- Variant injection via Theme App Extension (async, never blocks rendering)
- Guardrail monitoring: auto-pauses tests if AOV drops more than 3%
- Microsoft Clarity + Google Analytics 4 integrations
- Agency dashboard for managing multiple stores (Pro)
- Knowledge base that learns from every concluded test

---

## FAQ

**Q: Will this slow down my store?**
A: No. Variants are injected via an async/deferred script — it never blocks page rendering. Typical LCP impact is under 5ms.

**Q: Do I need to edit my theme Liquid files?**
A: No. Everything runs through a Shopify Theme App Extension block. You add it once in the theme editor, and it handles all experiments automatically.

**Q: How long does a typical test take?**
A: The app enforces a minimum of 7 days (for statistical validity) and a maximum of 28 days. Most tests reach significance in 10–14 days depending on traffic volume.

**Q: What happens when a test wins?**
A: The experiment is concluded, the result is saved to the knowledge base (so the AI learns from it), and the next hypothesis is automatically promoted and built on the Pro plan.

**Q: Is my customer data safe?**
A: Yes. The app never collects PII. Visitor IDs are randomly generated UUIDs — not linked to Shopify customer accounts. See our Privacy Policy for full details.

**Q: How do I get support?**
A: Email us at support@shivook.com. We respond within 1 business day.
