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
      // Math.imul gives correct 32-bit multiply without BigInt
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
    // CSS first so it's in place before HTML renders
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
          // Fallback for browsers without createContextualFragment
          var tmp = document.createElement('div');
          tmp.innerHTML = htmlPatch;
          while (tmp.firstChild) document.body.appendChild(tmp.firstChild);
        } catch (_2) {}
      }
    }

    if (jsPatch) {
      try {
        // Run in a sandboxed function scope — never use eval()
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
    // Fetch fallback with keepalive so it survives page navigations
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

  fetch(
    PROXY_BASE + '/api/experiments?pageType=' + encodeURIComponent(pageType),
    { credentials: 'same-origin' }
  )
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) {
      if (!data || !Array.isArray(data.experiments)) return;

      data.experiments.forEach(function (exp) {
        var variantType = assignVariant(visitorId, exp.id);

        var variant = null;
        for (var i = 0; i < exp.variants.length; i++) {
          if (exp.variants[i].type === variantType) { variant = exp.variants[i]; break; }
        }
        if (!variant) return;

        // Store variant ID so the web pixel can read it for add_to_cart / checkout events
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
