// PostHog for the marketing pages only — the landing page and /blog. Modelled on the
// bravio-landing setup (see its ANALYTICS.md) and reporting into the same PostHog
// project. Deliberately NOT loaded by /editor/ (people's own recordings are on screen
// there, and session replay would capture them) and never by the extension, which
// stays analytics-free — the privacy policy draws exactly that line.
//
// Ingestion goes through this site's own /relay path (rewrites in vercel.json) rather
// than us.i.posthog.com, which is on every mainstream tracker blocklist. The people
// blocking it skew toward exactly the developers and makers this product is for.
//
// With no POSTHOG_KEY set in Vercel, the site runs normally with analytics switched off.
(function () {
  'use strict';

  // PostHog project API key (starts with "phc_"). Injected at deploy time from the
  // POSTHOG_KEY environment variable in Vercel — see buildCommand in vercel.json. A
  // write-only ingestion key, public by design and safe in page source; never use a
  // *personal* API key. Unset (or a local copy) leaves the placeholder, which disables
  // analytics.
  var POSTHOG_KEY = '__POSTHOG_KEY__';
  var API_HOST = '/relay';
  // EU-hosted project: change this AND the two us.* hosts in vercel.json to eu.*.
  var UI_HOST = 'https://us.posthog.com';

  if (!/^phc_/.test(POSTHOG_KEY)) return;

  // Local previews (npx serve, file://) are excluded so developer clicks and reloads
  // don't inflate the real numbers. Add ?ph_debug=1 to any URL to send — and log — anyway.
  var host = location.hostname;
  var debug = /[?&]ph_debug=1\b/.test(location.search);
  var isProd = host === 'clickandrecord.tech' || host === 'www.clickandrecord.tech';
  if (!isProd && !debug) return;

  /* eslint-disable */
  // Official PostHog loader stub (posthog-js array snippet), unmodified. It queues calls
  // until /relay/static/array.js arrives, so nothing below has to wait for the network.
  !function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey getNextSurveyStep identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);
  /* eslint-enable */

  var posthog = window.posthog;

  posthog.init(POSTHOG_KEY, {
    api_host: API_HOST,
    ui_host: UI_HOST,
    // Current library behaviour rather than the legacy defaults.
    defaults: '2026-08-30',

    // Every click, form submit and input change, with element text and selector — no
    // per-element tagging, and it covers sections added later.
    autocapture: true,
    capture_dead_clicks: true,
    rageclick: true,
    capture_heatmaps: true,
    capture_pageview: true,
    capture_pageleave: true,
    capture_performance: { web_vitals: true, network_timing: true },

    // Session replay. Inputs are masked before leaving the browser. Exclude an element
    // entirely with class="ph-no-capture"; mask only its text with class="ph-mask".
    disable_session_recording: false,
    session_recording: { maskAllInputs: true },

    // Anonymous visitors don't get a person profile — billed at several times the rate of
    // anonymous events, and a marketing site's traffic is almost all one-off visits.
    // Funnels, unique visitors and replay all still work off the stable distinct_id.
    person_profiles: 'identified_only',

    loaded: function (ph) {
      if (debug) { ph.debug(); }
      ph.register({ site: 'clickandrecord.tech', page_kind: pageKind() });
    },
  });

  function pageKind() {
    var p = location.pathname;
    if (p === '/' || p === '/index.html') return 'landing';
    if (p === '/blog' || p === '/blog/' || p === '/blog/index.html') return 'blog_index';
    if (p.indexOf('/blog/') === 0) return 'blog_post';
    return 'other';
  }

  // ---------- named events ----------
  //
  // Autocapture already records every click. These exist because a funnel built on
  // `install_cta_clicked` survives a redesign; one built on a CSS selector doesn't.
  //
  //   install_cta_clicked    any click through to the Chrome Web Store — the conversion
  //   editor_cta_clicked     any click into /editor/ — the try-before-install path
  //   blog_post_clicked      a click from a listing/related card into an article
  //   outbound_link_clicked  any other link leaving the site
  //   page_engaged           15s of *visible* time on the page
  //   page_scrolled          passed 50% / 90% of the page
  //
  // Every CTA carries `location`: the id of the nearest section (hero, guides, get…),
  // or "masthead"/"footer"/"blog_cta", so the same button in four places can be told apart.

  function locationOf(el) {
    if (el.closest('.mast')) return 'masthead';
    if (el.closest('footer')) return 'footer';
    if (el.closest('.cta')) return 'blog_cta';
    var sec = el.closest('[data-analytics-section], section[id], section[class]');
    if (!sec) return 'unknown';
    return sec.getAttribute('data-analytics-section') || sec.id || sec.className.split(' ')[0] || 'unknown';
  }

  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    var href = a.getAttribute('href') || '';
    var props = { location: locationOf(a), text: (a.textContent || '').trim().slice(0, 80), href: href };

    if (href.indexOf('chromewebstore.google.com') !== -1 || a.getAttribute('data-cta') === 'chrome-store') {
      posthog.capture('install_cta_clicked', props);
    } else if (href.indexOf('/editor/') !== -1) {
      posthog.capture('editor_cta_clicked', props);
    } else if (/^\/blog\/[a-z0-9-]+$/.test(href) && a.closest('.card, .guide')) {
      posthog.capture('blog_post_clicked', props);
    } else if (/^https?:\/\//.test(href) && a.hostname !== location.hostname) {
      posthog.capture('outbound_link_clicked', props);
    }
  }, true);

  // Visible-time engagement: a page left open in a background tab accumulates nothing,
  // so this measures reading rather than flattering bounce rate.
  var ENGAGED_MS = 15000;
  var visibleMs = 0;
  var since = document.visibilityState === 'visible' ? Date.now() : null;
  var engaged = false;
  function tick() {
    if (engaged) return;
    var total = visibleMs + (since ? Date.now() - since : 0);
    if (total >= ENGAGED_MS) {
      engaged = true;
      posthog.capture('page_engaged', { engaged_ms: total });
    }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      since = Date.now();
    } else if (since) {
      visibleMs += Date.now() - since;
      since = null;
    }
  });
  var engagedTimer = setInterval(function () { tick(); if (engaged) clearInterval(engagedTimer); }, 1000);

  var milestones = [50, 90];
  var hit = {};
  window.addEventListener('scroll', function () {
    var doc = document.documentElement;
    var scrollable = doc.scrollHeight - window.innerHeight;
    if (scrollable <= 0) return;
    var depth = Math.round((window.scrollY / scrollable) * 100);
    for (var i = 0; i < milestones.length; i++) {
      var m = milestones[i];
      if (depth >= m && !hit[m]) {
        hit[m] = true;
        posthog.capture('page_scrolled', { depth: m });
      }
    }
  }, { passive: true });
})();
