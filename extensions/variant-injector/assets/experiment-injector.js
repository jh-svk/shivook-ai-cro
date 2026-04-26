(function () {
  'use strict';

  var PROXY_BASE    = '/apps/cro';
  var LS_VISITOR    = 'cro_visitor_id';
  var LS_ASSIGN_PFX = 'cro_assign_';
  var LS_VID_PFX    = 'cro_vid_';
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

  function buildContext() {
    return {
      deviceType:    detectDevice(),
      trafficSource: detectSource(),
      visitorType:   detectVisitorType(),
      hour:          new Date().getHours(),
      dayOfWeek:     new Date().getDay(),
      cartState:     'any',
    };
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
        // eslint-disable-next-line no-new-func
        (new Function(jsPatch))();
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

  // ── Bootstrap ───────────────────────────────────────────────────────────────
  var root = document.getElementById('cro-injector-root');
  if (!root) return;

  var pageType  = root.dataset.pageType || '';
  var visitorId = getOrCreate(lsGet, lsSet, LS_VISITOR,  uuid4);
  var sessionId = getOrCreate(ssGet, ssSet, SS_SESSION,  uuid4);
  var ctx       = buildContext();

  fetch(
    PROXY_BASE + '/api/experiments?pageType=' + encodeURIComponent(pageType),
    { credentials: 'same-origin' }
  )
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) {
      if (!data || !Array.isArray(data.experiments)) return;

      data.experiments.forEach(function (exp) {
        // Skip experiments this visitor doesn't match
        if (!matchesSegment(exp.segment, ctx)) return;

        var variantType = assignVariant(visitorId, exp.id);

        var variant = null;
        for (var i = 0; i < exp.variants.length; i++) {
          if (exp.variants[i].type === variantType) { variant = exp.variants[i]; break; }
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
    })
    .catch(function () {
      // Never throw — storefront stability is non-negotiable
    });
})();
