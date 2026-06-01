(function () {
  'use strict';

  var PROXY_BASE    = '/apps/cro';
  var LS_VISITOR    = 'cro_visitor_id';
  var LS_ASSIGN_PFX = 'cro_assign_';
  var LS_VID_PFX    = 'cro_vid_';
  var LS_ENROLLED   = 'cro_enrolled_experiment'; // the ONE test this visitor is in
  var SS_SESSION    = 'cro_session_id';

  // ── Stable 32-bit FNV-1a hash ──────────────────────────────────────────────
  function fnv32a(str) {
    var hash = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  }

  // ── UUID v4 ─────────────────────────────────────────────────────────────────
  function uuid4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  // ── Hex hash helper (FNV-1a → 8-char hex, used for visitor ID pseudonymisation) ─
  function hashHex(str) {
    return (fnv32a(str) >>> 0).toString(16).padStart(8, '0');
  }

  // ── Storage helpers (swallow errors on private-mode iOS) ────────────────────
  function lsGet(k)    { try { return localStorage.getItem(k);  } catch (_) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v);      } catch (_) {} }
  function ssGet(k)    { try { return sessionStorage.getItem(k);} catch (_) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v);    } catch (_) {} }

  function getOrCreate(getter, setter, key, factory) {
    var v = getter(key);
    if (!v) { v = factory(); setter(key, v); }
    return v;
  }

  // ── Segmentation helpers ────────────────────────────────────────────────────
  function detectDevice() {
    var w = window.innerWidth;
    if (w <= 768) return 'mobile';
    if (w <= 1024) return 'tablet';
    return 'desktop';
  }

  function detectSource() {
    var params = new URLSearchParams(window.location.search);
    var utmMedium = params.get('utm_medium') || '';
    if (utmMedium === 'cpc' || utmMedium === 'paid') return 'paid';
    if (utmMedium === 'email') return 'email';
    var ref = document.referrer;
    if (!ref) return 'direct';
    if (/facebook\.com|twitter\.com|instagram\.com|tiktok\.com/.test(ref)) return 'social';
    if (/google\.|bing\./.test(ref) && !utmMedium) return 'organic';
    return 'direct';
  }

  function detectVisitorType() {
    if (lsGet('cro_has_purchased')) return 'purchaser';
    if (lsGet(LS_VISITOR)) return 'returning';
    return 'new';
  }

  function buildContext(geoCountry) {
    return {
      deviceType:    detectDevice(),
      trafficSource: detectSource(),
      visitorType:   detectVisitorType(),
      hour:          new Date().getHours(),
      dayOfWeek:     new Date().getDay(),
      cartState:     'any',
      geoCountry:    geoCountry || 'XX',
    };
  }

  // Geo detection: fetch from app proxy with 1s timeout, cache 24h in localStorage
  function detectGeoCountry() {
    var cached    = lsGet('cro_geo_country');
    var cachedAt  = parseInt(lsGet('cro_geo_country_at') || '0', 10);
    if (cached && Date.now() - cachedAt < 86400000) {
      return Promise.resolve(cached);
    }
    return Promise.race([
      fetch(PROXY_BASE + '/api/geo').then(function (r) { return r.ok ? r.json() : { country: 'XX' }; }),
      new Promise(function (_, rej) { setTimeout(function () { rej(new Error('timeout')); }, 1000); }),
    ]).then(function (data) {
      var code = (data && data.country) || 'XX';
      lsSet('cro_geo_country', code);
      lsSet('cro_geo_country_at', String(Date.now()));
      return code;
    }).catch(function () { return 'XX'; });
  }

  // Returns true if the visitor matches the segment (null segment = always match)
  function matchesSegment(segment, ctx) {
    if (!segment) return true;

    if (segment.deviceType && segment.deviceType !== 'any' &&
        segment.deviceType !== ctx.deviceType) return false;

    if (segment.trafficSource && segment.trafficSource !== 'any' &&
        segment.trafficSource !== ctx.trafficSource) return false;

    if (segment.visitorType && segment.visitorType !== 'any' &&
        segment.visitorType !== ctx.visitorType) return false;

    if (segment.timeOfDayFrom != null && ctx.hour < segment.timeOfDayFrom) return false;
    if (segment.timeOfDayTo   != null && ctx.hour > segment.timeOfDayTo)   return false;

    if (segment.dayOfWeek && segment.dayOfWeek.length > 0 &&
        segment.dayOfWeek.indexOf(ctx.dayOfWeek) === -1) return false;

    if (segment.geoCountry && segment.geoCountry.length > 0 &&
        segment.geoCountry.indexOf(ctx.geoCountry) === -1) return false;

    // productCategory and cartState: stub — always match in Phase 3
    return true;
  }

  // ── Variant assignment (stable per visitor + experiment) ────────────────────
  function assignVariant(visitorId, experimentId) {
    var key    = LS_ASSIGN_PFX + experimentId;
    var stored = lsGet(key);
    if (stored === 'control' || stored === 'treatment') return stored;
    var bucket = fnv32a(visitorId + '|' + experimentId) % 2;
    var type   = bucket === 0 ? 'control' : 'treatment';
    lsSet(key, type);
    return type;
  }

  // ── Visibility helper ────────────────────────────────────────────────────────
  // Many themes (e.g. Dawn) render a HIDDEN duplicate of an element — the cart
  // DRAWER contains the same `.cart__checkout-button` as the visible cart page.
  // A naive querySelector returns the first match, which is often the hidden one,
  // so a variant injects into an invisible container and "does nothing".
  function croVisible(el) {
    if (!el) return false;
    if (typeof el.checkVisibility === 'function') {
      try { return el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true }); } catch (_) {}
    }
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    var node = el;
    while (node && node.nodeType === 1) {
      var cs;
      try { cs = getComputedStyle(node); } catch (_) { return true; }
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
      node = node.parentElement;
    }
    return true;
  }

  // Run `fn` with document.querySelector temporarily preferring a VISIBLE match
  // (falling back to the first match if none are visible). Scoped to the variant's
  // synchronous execution, then restored — the theme's own code is unaffected.
  function withVisiblePreferredQuery(fn) {
    var nativeQS = document.querySelector;
    var nativeQSA = document.querySelectorAll.bind(document);
    document.querySelector = function (sel) {
      try {
        var matches = nativeQSA(sel);
        for (var i = 0; i < matches.length; i++) {
          if (croVisible(matches[i])) return matches[i];
        }
        return matches.length ? matches[0] : null;
      } catch (_) {
        try { return nativeQS.call(document, sel); } catch (_2) { return null; }
      }
    };
    try { fn(); } finally { document.querySelector = nativeQS; }
  }

  // ── DOM patching ────────────────────────────────────────────────────────────
  function applyPatch(htmlPatch, cssPatch, jsPatch) {
    if (cssPatch) {
      try {
        var style = document.createElement('style');
        style.textContent = cssPatch;
        document.head.appendChild(style);
      } catch (_) {}
    }

    if (htmlPatch) {
      try {
        var frag = document.createRange().createContextualFragment(htmlPatch);
        document.body.appendChild(frag);
      } catch (_) {
        try {
          var tmp = document.createElement('div');
          tmp.innerHTML = htmlPatch;
          while (tmp.firstChild) document.body.appendChild(tmp.firstChild);
        } catch (_2) {}
      }
    }

    if (jsPatch) {
      try {
        // Some generated variants wrap their JS in <script>…</script>. new Function
        // expects raw JS, so a wrapped patch is a syntax error and the variant
        // silently does nothing. Strip any <script> wrapper before executing.
        var code = jsPatch;
        if (/<script[\s>]/i.test(code)) {
          var inner = code.replace(/<script[^>]*>/gi, '').replace(/<\/script>/gi, '');
          code = inner.trim();
        }
        // eslint-disable-next-line no-new-func
        withVisiblePreferredQuery(function () { (new Function(code))(); });
      } catch (_) {}
    }
  }

  // ── Event firing (sendBeacon with fetch fallback) ───────────────────────────
  function fireViewEvent(payload) {
    var url  = PROXY_BASE + '/api/events';
    var body = JSON.stringify(payload);
    try {
      if (navigator.sendBeacon) {
        navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
        return;
      }
    } catch (_) {}
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body,
      keepalive: true,
    }).catch(function () {});
  }

  // ── Preview mode ─────────────────────────────────────────────────────────────
  var previewParams        = new URLSearchParams(window.location.search);
  var previewExperimentId  = previewParams.get('cro_preview_experiment');
  var previewVariantId     = previewParams.get('cro_preview_variant');

  if (previewExperimentId && previewVariantId) {
    // Preview mode: apply a specific variant without touching localStorage or firing events
    var root = document.getElementById('cro-injector-root');
    var pageType = root ? (root.dataset.pageType || '') : '';

    fetch(
      PROXY_BASE + '/api/experiments?pageType=' + encodeURIComponent(pageType) + '&preview=1',
      { credentials: 'same-origin' }
    )
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (!data || !Array.isArray(data.experiments)) return;

        for (var ei = 0; ei < data.experiments.length; ei++) {
          var exp = data.experiments[ei];
          if (exp.id !== previewExperimentId) continue;

          var variant = null;
          for (var vi = 0; vi < exp.variants.length; vi++) {
            if (exp.variants[vi].id === previewVariantId) { variant = exp.variants[vi]; break; }
          }
          if (!variant) break;

          applyPatch(variant.htmlPatch, variant.cssPatch, variant.jsPatch);

          // Preview banner
          var banner = document.createElement('div');
          banner.id = 'cro-preview-banner';
          banner.style.cssText = [
            'position:fixed', 'bottom:16px', 'right:16px', 'z-index:999999',
            'background:#000', 'color:#fff', 'font-size:12px', 'padding:8px 12px',
            'border-radius:6px', 'font-family:sans-serif', 'opacity:0.85',
            'pointer-events:none',
          ].join(';');
          banner.textContent = 'CRO Preview — ' + (variant.type || 'variant') + ' variant';
          document.body.appendChild(banner);
          break;
        }
      })
      .catch(function () {});

    return; // Do not run normal assignment logic in preview mode
  }

  // ── Bootstrap ───────────────────────────────────────────────────────────────
  var root = document.getElementById('cro-injector-root');
  if (!root) return;

  var pageType  = root.dataset.pageType || '';
  // Store a stable raw UUID locally; hash it before any transmission so no
  // raw identifier leaves the browser — satisfies the "visitorId (hashed)" spec.
  var rawVisitorId = getOrCreate(lsGet, lsSet, LS_VISITOR, uuid4);
  var visitorId    = hashHex(rawVisitorId);
  var rawSessionId = getOrCreate(ssGet, ssSet, SS_SESSION, uuid4);
  var sessionId    = hashHex(rawSessionId);

  detectGeoCountry().then(function (geoCountry) {
    var ctx = buildContext(geoCountry);

    return fetch(
      PROXY_BASE + '/api/experiments?pageType=' + encodeURIComponent(pageType),
      { credentials: 'same-origin' }
    )
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
      if (!data || !Array.isArray(data.experiments)) return;

      var pageExps  = data.experiments;                                   // current page, with variants
      var allActive = Array.isArray(data.allActive) ? data.allActive : null;

      // Mutual exclusion: a visitor is enrolled in AT MOST ONE experiment they
      // match (by segment), and stays in it for its lifetime. Two experiments
      // only "overlap" when a single visitor matches both — so this guarantees
      // no visitor is ever exposed to two interacting tests, while different
      // visitors still populate different tests based on their segment.

      // Release the visitor if their enrolled test is no longer active.
      var enrolledId = lsGet(LS_ENROLLED) || null;
      if (enrolledId && allActive) {
        var stillActive = false;
        for (var a = 0; a < allActive.length; a++) {
          if (allActive[a].id === enrolledId) { stillActive = true; break; }
        }
        if (!stillActive) { enrolledId = null; lsSet(LS_ENROLLED, ''); }
      }

      var exp = null;
      if (enrolledId) {
        // Already committed — only act if the enrolled test lives on this page.
        for (var i = 0; i < pageExps.length; i++) {
          if (pageExps[i].id === enrolledId) { exp = pageExps[i]; break; }
        }
      } else {
        // Not yet enrolled — commit to ONE matched test on this page (the
        // choice is deterministic per visitor, so it's stable + evenly split).
        var matchedHere = pageExps.filter(function (e) { return matchesSegment(e.segment, ctx); });
        if (matchedHere.length > 0) {
          matchedHere.sort(function (x, y) { return x.id < y.id ? -1 : x.id > y.id ? 1 : 0; });
          exp = matchedHere[fnv32a(rawVisitorId + '|cro_enroll') % matchedHere.length];
          lsSet(LS_ENROLLED, exp.id);
        }
      }
      if (!exp) return; // committed to a test on another page, or no match here

      var variantType = assignVariant(rawVisitorId, exp.id);
      var variant = null;
      for (var j = 0; j < exp.variants.length; j++) {
        if (exp.variants[j].type === variantType) { variant = exp.variants[j]; break; }
      }
      if (!variant) return;

      lsSet(LS_VID_PFX + exp.id, variant.id);
      applyPatch(variant.htmlPatch, variant.cssPatch, variant.jsPatch);
      fireViewEvent({
        experimentId: exp.id,
        variantId:    variant.id,
        visitorId:    visitorId,
        sessionId:    sessionId,
        eventType:    'view',
      });
      });
  }).catch(function () {
    // Never throw — storefront stability is non-negotiable
  });
})();
