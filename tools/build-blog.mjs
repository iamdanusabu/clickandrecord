#!/usr/bin/env node
// Builds the static blog under site/blog/ from the sources in blog-src/.
//
//   node tools/build-blog.mjs
//
// Each blog-src/<slug>.html starts with a <!--meta {json} --> block (see
// blog-src/_BRIEF.md) followed by the article body. This script wraps every body in
// the site's page chrome, renders the FAQ from metadata (so the visible copy and the
// FAQPage JSON-LD can never disagree), writes the /blog index, regenerates the blog
// <url> entries in sitemap.xml, and refreshes the blog list in llms.txt.
//
// No dependencies on purpose: the site ships as plain static files, and so does this.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'blog-src');
const SITE = path.join(ROOT, 'site');
const OUT = path.join(SITE, 'blog');
const ORIGIN = 'https://clickandrecord.tech';
const STORE_URL = 'https://chromewebstore.google.com/detail/lfpnagkdegnjjghefcbpeoblgoaklnnn';

const CATEGORIES = [
  'Product demos',
  'Recording techniques',
  'Bug reports & QA',
  'Subtitles & editing',
  'Comparisons & use cases',
];

// ---------- load ----------

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// Body copy may already contain entities (&amp;); only escape bare ampersands.
const escText = (s) => String(s)
  .replace(/&(?![a-zA-Z]+;|#\d+;)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function loadPosts() {
  const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.html')).sort();
  const posts = files.map((file) => {
    const raw = fs.readFileSync(path.join(SRC, file), 'utf8');
    const m = raw.match(/^\s*<!--meta\s*([\s\S]*?)-->\s*/);
    if (!m) throw new Error(`${file}: missing <!--meta --> block`);
    let meta;
    try { meta = JSON.parse(m[1]); } catch (err) { throw new Error(`${file}: bad meta JSON — ${err.message}`); }
    const body = raw.slice(m[0].length).trim();
    const slug = meta.slug || file.replace(/\.html$/, '');
    if (`${slug}.html` !== file) throw new Error(`${file}: slug "${slug}" doesn't match filename`);
    for (const k of ['title', 'h1', 'description', 'category']) {
      if (!meta[k]) throw new Error(`${file}: meta.${k} is required`);
    }
    if (!CATEGORIES.includes(meta.category)) throw new Error(`${file}: unknown category "${meta.category}"`);
    const words = body.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
    return {
      ...meta,
      slug,
      body,
      words,
      minutes: Math.max(3, Math.round(words / 230)),
      date: meta.date || '2026-10-10',
      faq: Array.isArray(meta.faq) ? meta.faq : [],
      related: Array.isArray(meta.related) ? meta.related : [],
    };
  });
  const bySlug = new Map(posts.map((p) => [p.slug, p]));
  // Internal links to posts that don't exist are dead links on a live site — fail loudly.
  for (const p of posts) {
    for (const [, target] of p.body.matchAll(/href="\/blog\/([a-z0-9-]+)"/g)) {
      if (!bySlug.has(target)) throw new Error(`${p.slug}.html: links to missing post /blog/${target}`);
    }
    p.related = p.related.filter((s) => bySlug.has(s) && s !== p.slug);
  }
  return { posts, bySlug };
}

// ---------- page chrome ----------

const THEME_BOOT = `<script>
(function(){try{var t=localStorage.getItem('cr-theme');
if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t);}catch(e){}})();
</script>`;

const THEME_TOGGLE = `<script>
(function () {
  var root = document.documentElement;
  var btn = document.getElementById('themer');
  if (!btn) return;
  function sync() {
    var dark = root.getAttribute('data-theme') === 'dark';
    btn.setAttribute('aria-pressed', String(dark));
    btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', dark ? '#0c0e13' : '#ffffff');
  }
  btn.addEventListener('click', function () {
    var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('cr-theme', next); } catch (e) {}
    sync();
  });
  sync();
})();
</script>`;

function head({ title, description, url, type = 'website', jsonld }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />

<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<link rel="canonical" href="${url}" />
<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1" />
<meta name="theme-color" content="#ffffff" />
<meta name="color-scheme" content="light dark" />

<meta property="og:type" content="${type}" />
<meta property="og:site_name" content="Click &amp; Record" />
<meta property="og:url" content="${url}" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:image" content="${ORIGIN}/og-image.png" />
<meta property="og:image:alt" content="Click &amp; Record" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(title)}" />
<meta name="twitter:description" content="${esc(description)}" />
<meta name="twitter:image" content="${ORIGIN}/og-image.png" />

<link rel="icon" href="/favicon.png" type="image/png" sizes="128x128" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
<link rel="preload" href="/fonts/archivo-latin.woff2" as="font" type="font/woff2" crossorigin />
<link rel="preload" href="/fonts/inter-latin.woff2" as="font" type="font/woff2" crossorigin />
<link rel="stylesheet" href="/blog/blog.css" />
<script src="/analytics.js" defer></script>

${THEME_BOOT}

<script type="application/ld+json">
${JSON.stringify(jsonld, null, 2).replace(/</g, '\\u003c')}
</script>
</head>
<body>

<a class="skip" href="#main">Skip to content</a>
`;
}

const MAST = `<header class="mast">
  <div class="shell">
    <a class="wordmark" href="/"><span class="dotrec" aria-hidden="true"></span> Click&nbsp;&amp;&nbsp;Record</a>
    <nav aria-label="Primary">
      <a href="/#zoom">Zoom</a>
      <a href="/#subtitles">Subtitles</a>
      <a href="/#evidence">Evidence</a>
      <a href="/blog">Blog</a>
      <a href="/editor/editor.html">Editor</a>
      <button class="themer" id="themer" type="button" aria-pressed="false"
              aria-label="Switch to dark theme" title="Switch theme">
        <svg class="ico-sun" viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
          <circle cx="10" cy="10" r="3.6" stroke="currentColor" stroke-width="1.5"/>
          <path d="M10 1.8v2.1M10 16.1v2.1M18.2 10h-2.1M3.9 10H1.8M15.8 4.2l-1.5 1.5M5.7 14.3l-1.5 1.5M15.8 15.8l-1.5-1.5M5.7 5.7L4.2 4.2"
                stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
        </svg>
        <svg class="ico-moon" viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
          <path d="M16.5 12.4A7 7 0 017.6 3.5a7 7 0 108.9 8.9z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
        </svg>
      </button>
      <a class="btn btn-solid" href="${STORE_URL}" target="_blank" rel="noopener" data-cta="chrome-store">Add to Chrome</a>
    </nav>
  </div>
</header>
`;

function footer(posts) {
  const pick = (cat) => posts.filter((p) => p.category === cat).slice(0, 4)
    .map((p) => `        <li><a href="/blog/${p.slug}">${esc(p.keywordLabel || shortTitle(p))}</a></li>`).join('\n');
  return `<footer>
  <div class="shell">
    <div class="fcols">
      <div>
        <a class="wordmark" href="/"><span class="dotrec" aria-hidden="true"></span> Click&nbsp;&amp;&nbsp;Record</a>
        <p style="margin-top:14px;max-width:32ch;color:var(--faint)">
          The screen recorder that pushes in on every click — and can prove what the app was doing.
        </p>
      </div>
      <div><h3>Product</h3><ul>
        <li><a href="/#zoom">Automatic zoom</a></li>
        <li><a href="/#subtitles">Subtitles</a></li>
        <li><a href="/#evidence">Network &amp; console</a></li>
        <li><a href="/editor/editor.html">Open the editor</a></li>
      </ul></div>
      <div><h3>Guides</h3><ul>
${pick('Product demos')}
      </ul></div>
      <div><h3>More</h3><ul>
        <li><a href="/blog">All articles</a></li>
        <li><a href="/#faq">FAQ</a></li>
        <li><a href="/privacy">Privacy</a></li>
        <li><a href="/terms">Terms</a></li>
      </ul></div>
    </div>
    <div class="rule">
      <span>© 2026 Click &amp; Record</span>
      <span>Built for people who make demos.</span>
    </div>
  </div>
</footer>

${THEME_TOGGLE}

</body>
</html>
`;
}

function shortTitle(p) {
  // "How to X (Step-by-Step)" -> "How to X"; keeps footer and cards tidy.
  return p.title.replace(/\s*[(\[].*?[)\]]\s*$/, '').replace(/\s+[—|-]\s+.*$/, '');
}

const CTA = `<aside class="cta" aria-label="Try Click &amp; Record">
  <p class="tc" data-mark="rec">Free · No account · Nothing uploaded</p>
  <h2>Record it once. Get the zooms for free.</h2>
  <p>Click &amp; Record is a free Chrome extension that turns every click into a smooth zoom, transcribes subtitles on your own machine, and can capture network and console logs alongside the video.</p>
  <div class="actions">
    <a class="btn btn-solid" href="${STORE_URL}" target="_blank" rel="noopener" data-cta="chrome-store"><span class="dotrec" aria-hidden="true"></span> Add to Chrome</a>
    <a class="btn btn-line" href="/editor/editor.html" data-cta="open-editor">Try the editor in your browser</a>
  </div>
</aside>`;

const fmtDate = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
  year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
});

// ---------- article ----------

function renderPost(p, ctx) {
  const url = `${ORIGIN}/blog/${p.slug}`;
  const toc = [...p.body.matchAll(/<h2>([\s\S]*?)<\/h2>/g)].map((m, i) => ({
    id: `s${i + 1}-${m[1].replace(/<[^>]+>/g, '').toLowerCase().replace(/&[a-z]+;/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)}`,
    html: m[1],
  }));
  let i = 0;
  const body = p.body.replace(/<h2>/g, () => `<h2 id="${toc[i++].id}">`)
    // External links open in a new tab; internal ones stay put.
    .replace(/<a href="(https?:\/\/(?!clickandrecord\.tech)[^"]+)"(?![^>]*target=)/g, '<a href="$1" target="_blank"');

  const faqHtml = p.faq.length ? `
    <section class="post-faq" id="faq">
      <h2>Frequently asked questions</h2>
      <div class="faq">
${p.faq.map((f, n) => `        <details${n === 0 ? ' open' : ''}>
          <summary>${escText(f.q)}</summary>
          <div><p>${escText(f.a)}</p></div>
        </details>`).join('\n')}
      </div>
    </section>` : '';

  const related = p.related.map((s) => ctx.bySlug.get(s));
  const relatedHtml = related.length ? `
  <section class="related shell" aria-labelledby="related-h">
    <h2 id="related-h">Keep reading</h2>
    <div class="cards">
${related.map(card).join('\n')}
    </div>
  </section>` : '';

  const jsonld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'BlogPosting',
        '@id': `${url}#article`,
        headline: p.h1,
        name: p.title,
        description: p.description,
        url,
        mainEntityOfPage: url,
        datePublished: p.date,
        dateModified: p.updated || p.date,
        inLanguage: 'en',
        articleSection: p.category,
        keywords: p.keyword || undefined,
        wordCount: p.words,
        image: `${ORIGIN}/og-image.png`,
        author: { '@type': 'Organization', name: 'Click & Record', url: `${ORIGIN}/` },
        publisher: {
          '@type': 'Organization',
          name: 'Click & Record',
          url: `${ORIGIN}/`,
          logo: { '@type': 'ImageObject', url: `${ORIGIN}/apple-touch-icon.png` },
        },
        about: { '@type': 'SoftwareApplication', name: 'Click & Record', url: `${ORIGIN}/` },
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: `${ORIGIN}/` },
          { '@type': 'ListItem', position: 2, name: 'Blog', item: `${ORIGIN}/blog` },
          { '@type': 'ListItem', position: 3, name: p.h1, item: url },
        ],
      },
      ...(p.faq.length ? [{
        '@type': 'FAQPage',
        mainEntity: p.faq.map((f) => ({
          '@type': 'Question',
          name: f.q,
          acceptedAnswer: { '@type': 'Answer', text: f.a },
        })),
      }] : []),
    ],
  };

  return head({ title: `${p.title}`, description: p.description, url, type: 'article', jsonld })
    + MAST + `
<main id="main">
  <div class="shell post-head">
    <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> <span aria-hidden="true">/</span> <a href="/blog">Blog</a> <span aria-hidden="true">/</span> <span>${esc(p.category)}</span></nav>
    <p class="tc" data-mark="${markFor(p.category)}">${esc(p.category)} · ${p.minutes} min read</p>
    <h1>${escText(p.h1)}</h1>
    <p class="updated">Published <time datetime="${p.date}">${fmtDate(p.date)}</time> · Click &amp; Record team</p>
${toc.length >= 3 ? `    <nav class="toc" aria-label="On this page">
${toc.map((t) => `      <a href="#${t.id}">${t.html.replace(/<[^>]+>/g, '')}</a>`).join('\n')}
    </nav>` : ''}
  </div>

  <div class="shell">
    <article class="post">
${body}
${faqHtml}
    </article>
    ${CTA}
  </div>
${relatedHtml}
</main>

` + footer(ctx.posts);
}

function markFor(cat) {
  return {
    'Product demos': 'zoom',
    'Recording techniques': 'rec',
    'Bug reports & QA': 'link',
    'Subtitles & editing': 'cue',
    'Comparisons & use cases': 'zoom',
  }[cat] || 'link';
}

function card(p) {
  return `      <a class="card" href="/blog/${p.slug}">
        <span class="tc" data-mark="${markFor(p.category)}">${esc(p.category)}</span>
        <h3>${escText(p.h1)}</h3>
        <p>${esc(p.description)}</p>
        <span class="more">${p.minutes} min read →</span>
      </a>`;
}

// ---------- index ----------

function renderIndex(ctx) {
  const url = `${ORIGIN}/blog`;
  const title = 'Screen Recording Guides & Tutorials — Click & Record Blog';
  const description = 'Practical guides to product demo videos, auto-zoom screen recording, bug reports with network logs, subtitles and video editing — free, in your browser.';
  const groups = CATEGORIES.map((cat) => ({ cat, posts: ctx.posts.filter((p) => p.category === cat) }))
    .filter((g) => g.posts.length);
  const anchor = (cat) => cat.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-');

  const jsonld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Blog',
        '@id': `${url}#blog`,
        name: 'Click & Record Blog',
        description,
        url,
        publisher: { '@type': 'Organization', name: 'Click & Record', url: `${ORIGIN}/` },
        blogPost: ctx.posts.map((p) => ({
          '@type': 'BlogPosting',
          headline: p.h1,
          url: `${ORIGIN}/blog/${p.slug}`,
          datePublished: p.date,
        })),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Home', item: `${ORIGIN}/` },
          { '@type': 'ListItem', position: 2, name: 'Blog', item: url },
        ],
      },
    ],
  };

  return head({ title, description, url, jsonld }) + MAST + `
<main id="main">
  <div class="shell post-head">
    <p class="tc" data-mark="link">Blog · ${ctx.posts.length} guides</p>
    <h1>Guides to recording, editing and shipping screen videos.</h1>
    <p class="lede">How to make product demos people finish, bug reports developers can act on, and tutorials with subtitles — with the free tools that do the tedious parts for you.</p>
    <nav class="toc" aria-label="Topics">
${groups.map((g) => `      <a href="#${anchor(g.cat)}">${esc(g.cat)}</a>`).join('\n')}
    </nav>
  </div>
${groups.map((g) => `
  <section class="shell blog-group" id="${anchor(g.cat)}">
    <h2>${esc(g.cat)}</h2>
    <div class="cards">
${g.posts.map(card).join('\n')}
    </div>
  </section>`).join('\n')}
  <div class="shell">${CTA}</div>
</main>

` + footer(ctx.posts);
}

// ---------- css ----------

function buildCss() {
  // Reuse the privacy page's tokens and chrome verbatim so the blog can't drift from
  // the rest of the site, then add the article-specific rules below.
  const privacy = fs.readFileSync(path.join(SITE, 'privacy', 'index.html'), 'utf8');
  const base = privacy.match(/<style>([\s\S]*?)<\/style>/)[1].trim();
  return `/* Generated by tools/build-blog.mjs — edit there, not here. */
${base}

/* ═══ BLOG ═══ */
.btn-line{background:transparent;color:var(--ink);border-color:var(--edge-strong)}
.btn-line:hover{border-color:var(--ink);transform:translateY(-1px)}
.post-head{padding-top:clamp(44px,6vw,76px);padding-bottom:clamp(28px,4vw,40px)}
.post-head h1{font-size:clamp(2rem,4.4vw,3.1rem);max-width:22ch}
.post-head .updated{margin-top:18px;font-size:.86rem;color:var(--faint)}
.post-head .lede{margin-top:20px}
.post-head .toc a{white-space:normal}
.post-head h1,.post h2,.post h3{overflow-wrap:break-word}
.crumbs{font-size:.8rem;color:var(--faint);margin-bottom:26px;display:flex;flex-wrap:wrap;gap:8px}
.crumbs a{color:var(--mute)}
.crumbs a:hover{color:var(--ink)}

.post{max-width:72ch;padding-bottom:12px}
.post > p:first-child{font-size:1.1rem;color:var(--ink);line-height:1.6}
.post h2{margin-top:52px;scroll-margin-top:84px}
.post h3{margin-top:30px;font-size:1.08rem}
.post p,.post li{color:var(--mute);font-size:1.01rem}
.post strong{color:var(--ink);font-weight:600}
.post a{color:var(--link);text-decoration:underline;text-underline-offset:3px}
.post a:hover{color:var(--ink)}
.post ul,.post ol{padding-left:1.3em;margin:0 0 20px}
.post li{margin-bottom:8px}
.post li::marker{color:var(--faint)}
.post code{font-family:var(--mono);font-size:.86em;background:var(--raise);border:1px solid var(--edge);
  padding:1px 6px;border-radius:5px;color:var(--ink);overflow-wrap:anywhere}
.post blockquote{margin:24px 0;padding:4px 0 4px 20px;border-left:3px solid var(--zoom-mark)}
.post blockquote p{color:var(--ink)}
.post table{display:block;overflow-x:auto;min-width:0;max-width:100%;margin:22px 0;border:1px solid var(--edge);border-radius:10px;background:var(--surface)}
.post thead th{white-space:nowrap}
.post-faq{margin-top:56px;padding-top:8px;border-top:1px solid var(--edge)}
.post-faq h2{margin-top:36px}

.faq{border-top:1px solid var(--edge);margin-top:18px}
.faq details{border-bottom:1px solid var(--edge)}
.faq summary{cursor:pointer;list-style:none;padding:18px 32px 18px 0;position:relative;
  font-weight:600;color:var(--ink);font-size:1rem}
.faq summary::-webkit-details-marker{display:none}
.faq summary::after{content:'+';position:absolute;right:4px;top:15px;font-size:1.3rem;color:var(--faint);font-weight:400}
.faq details[open] summary::after{content:'–'}
.faq details > div{padding:0 0 18px}
.faq details p{color:var(--mute);margin:0}

.cta{margin:56px 0 clamp(56px,8vw,96px);padding:clamp(26px,4vw,40px);border:1px solid var(--edge);
  border-radius:14px;background:var(--surface);max-width:72ch}
.cta h2{margin-bottom:12px}
.cta p{color:var(--mute)}
.cta .tc{margin-bottom:16px}
.cta .actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:22px}

.related{padding-top:clamp(40px,6vw,64px);padding-bottom:clamp(56px,8vw,96px)}
.related::after{content:'';position:absolute;left:var(--rail);right:var(--gut);top:0;border-top:1px solid var(--edge)}
.blog-group{padding-top:clamp(36px,5vw,56px);padding-bottom:clamp(16px,3vw,24px)}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:16px;margin-top:22px}
.card{display:flex;flex-direction:column;padding:22px;border:1px solid var(--edge);border-radius:12px;
  background:var(--void);transition:border-color .16s ease,transform .16s ease,background .16s ease}
.card:hover{border-color:var(--edge-strong);background:var(--hover);transform:translateY(-2px)}
.card .tc{margin-bottom:14px;font-size:10.5px}
.card h3{font-size:1.05rem;margin-bottom:10px}
.card p{font-size:.88rem;color:var(--mute);line-height:1.5;margin-bottom:16px;flex:1}
.card .more{font-size:.82rem;color:var(--link);font-weight:500}
`;
}

// ---------- sitemap + llms.txt ----------

function updateSitemap(posts) {
  const file = path.join(SITE, 'sitemap.xml');
  let xml = fs.readFileSync(file, 'utf8');
  const START = '  <!-- blog:start (generated by tools/build-blog.mjs) -->';
  const END = '  <!-- blog:end -->';
  xml = xml.replace(new RegExp(`\\n?${START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END}`), '');
  const latest = posts.reduce((d, p) => ((p.updated || p.date) > d ? (p.updated || p.date) : d), '0');
  const entries = [
    `  <url>\n    <loc>${ORIGIN}/blog</loc>\n    <lastmod>${latest}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.7</priority>\n  </url>`,
    ...posts.map((p) => `  <url>\n    <loc>${ORIGIN}/blog/${p.slug}</loc>\n    <lastmod>${p.updated || p.date}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.6</priority>\n  </url>`),
  ];
  xml = xml.replace('</urlset>', `${START}\n${entries.join('\n')}\n${END}\n</urlset>`);
  fs.writeFileSync(file, xml);
}

function updateLlms(posts) {
  const file = path.join(SITE, 'llms.txt');
  let txt = fs.readFileSync(file, 'utf8');
  const START = '<!-- blog:start -->';
  const END = '<!-- blog:end -->';
  const block = `${START}\n- [Blog](${ORIGIN}/blog): ${posts.length} guides on demo videos, auto-zoom recording, bug reports, subtitles and editing.\n${
    CATEGORIES.map((cat) => {
      const ps = posts.filter((p) => p.category === cat);
      return ps.length ? `\n### ${cat}\n\n${ps.map((p) => `- [${p.h1}](${ORIGIN}/blog/${p.slug}): ${p.description}`).join('\n')}` : '';
    }).join('\n')}\n${END}`;
  if (txt.includes(START)) {
    txt = txt.replace(new RegExp(`${START}[\\s\\S]*?${END}`), block);
  } else {
    txt = txt.replace(/(- \[Home\]\([^\n]*\n)/, `$1${block}\n`);
  }
  fs.writeFileSync(file, txt);
}

// ---------- home page "Guides" block ----------

// Demos and showcase first — that's the product's core use case. Missing slugs are
// skipped, so this list can name posts before they exist.
const FEATURED = [
  'how-to-make-a-product-demo-video',
  'what-is-an-auto-zoom-screen-recorder',
  'product-walkthrough-video',
  'saas-demo-video-best-practices',
  'add-subtitles-to-screen-recording-free',
  'how-to-make-a-tutorial-video',
  'product-hunt-launch-video',
  'cursorful-alternative',
];

function updateHome(ctx) {
  const file = path.join(SITE, 'index.html');
  let html = fs.readFileSync(file, 'utf8');
  const START = '<!-- guides:start (generated by tools/build-blog.mjs) -->';
  const END = '<!-- guides:end -->';
  if (!html.includes(START)) throw new Error('index.html: guides markers missing');
  const picks = FEATURED.map((s) => ctx.bySlug.get(s)).filter(Boolean).slice(0, 6);
  const cards = picks.map((p) => `        <a class="guide" href="/blog/${p.slug}">
          <span class="cat">${esc(p.category)}</span>
          <h3>${escText(p.h1)}</h3>
          <p>${esc(p.description)}</p>
          <span class="more">${p.minutes} min read →</span>
        </a>`).join('\n');
  html = html.replace(new RegExp(`${START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END}`), `${START}\n${cards}\n${END}`);
  fs.writeFileSync(file, html);
}

// ---------- main ----------

const ctx = loadPosts();
// Index and footer list categories in a fixed order, newest/alphabetical within.
ctx.posts.sort((a, b) => CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) || a.slug.localeCompare(b.slug));

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'blog.css'), buildCss());
fs.writeFileSync(path.join(OUT, 'index.html'), renderIndex(ctx));
for (const p of ctx.posts) {
  fs.mkdirSync(path.join(OUT, p.slug), { recursive: true });
  fs.writeFileSync(path.join(OUT, p.slug, 'index.html'), renderPost(p, ctx));
}
updateSitemap(ctx.posts);
updateLlms(ctx.posts);
updateHome(ctx);

const short = ctx.posts.filter((p) => p.words < 800).map((p) => `${p.slug} (${p.words})`);
console.log(`Built ${ctx.posts.length} posts → site/blog/`);
if (short.length) console.log(`Short posts: ${short.join(', ')}`);
