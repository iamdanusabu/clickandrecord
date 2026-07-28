# SEO notes — clickandrecord.tech

Why the landing page is built the way it is, what you must fill in before launch, and
what actually moves rankings once it is live.

---

## What the competitive analysis found

**Cursorful** (fetched 2026-07-28) targets one phrase hard. Their H1 is *"Screen recorder
with automatic zoom"*, and the page repeats zoom/cursor/pan language throughout. Structure:
value props → features → pricing (free tier, $79 one-time Pro) → FAQ → roadmap.

Two things matter for us:

1. **They ship no schema.org markup.** No `FAQPage`, no `SoftwareApplication`. That is free
   ground — structured data is the cheapest way to take up more vertical space in the
   results page than a competitor with a stronger domain.
2. **They have no subtitles and no network/console capture.** Their feature list stops at
   video polish.

**The category is crowded on that one phrase.** Searching *"screen recorder with automatic
zoom on clicks chrome extension"* returns Cursorful, Zumie, SnapZoom, ZoomFlow,
SuperchargeCapture and roundup articles. Fighting head-on for *"auto zoom screen recorder"*
against six incumbents with older domains is a two-year project, not a launch plan.

**But the adjacent category doesn't overlap at all.** Searching for network/console/HAR
recording returns a completely different set — PlayLog, DevRecorder, Crosscheck, Screendesk,
Bug Reproduction Recorder. Those tools capture the logs and produce plain video. **No product
appears in both result sets.**

## The strategy: own the intersection

Click & Record is the only tool that does demo polish *and* debugging evidence *and*
on-device subtitles. So the page is built to rank for three tiers:

| Tier | Example queries | Realistic outcome |
| --- | --- | --- |
| **Head** (contested) | screen recorder with automatic zoom, auto zoom screen recorder chrome | Long game. Included, not depended on. |
| **Comparison** (winnable) | cursorful alternative, screen studio alternative free, cursorful vs | Months. The comparison section targets these. |
| **Intersection** (uncontested) | screen recorder that captures network requests, demo recorder with console logs, screen recorder with offline subtitles, bug report screen recorder with zoom | Weeks. Low volume, very high intent. |

Tier three is where the early wins are, and the traffic converts far better because
somebody searching *"screen recorder that captures network requests"* has already decided
what they need.

## What is built into the page

- **Title** 59 chars, keyword-first; **meta description** 156 chars. Both inside Google's
  truncation limits (verified).
- **One `<h1>`** carrying the primary phrase as natural language; 8 `<h2>` sections in a
  clean hierarchy.
- **JSON-LD** with `SoftwareApplication`, `FAQPage`, `Organization`, `WebSite` — validated
  as parsing, and all 8 FAQ answers verified to match the visible copy exactly. That match
  matters: schema that disagrees with the page is a manual-action risk, not just a lost
  snippet.
- **No `aggregateRating` or review markup.** Deliberate. Inventing ratings violates Google's
  guidelines and would be dishonest. Add it once you have real Chrome Web Store reviews, and
  point it at the actual number.
- **Zero external requests.** Both typefaces self-hosted and preloaded, CSS inlined, no
  analytics or tag manager on the critical path. Core Web Vitals are a ranking factor and
  this page has nothing render-blocking.
- **Served from the domain root** (`/`), not a subdirectory. The root URL is the one that
  accumulates links and authority; a landing page buried at `/landing/` splits that signal
  and looks provisional.
- **Accessibility**: skip link, `lang`, semantic landmarks, alt text, visible focus. Overlaps
  heavily with crawlability.
- `robots.txt` and `sitemap.xml` included. `/editor/` is disallowed — an indexed `?session=`
  URL is a dead link for everyone except its owner.

## Fill these in before launch

The page is honest about what the software does. These are the placeholders:

- [ ] **Chrome Web Store URL** — both `Add to Chrome` buttons are `href="#"`. The one in the
      final CTA carries `data-cta="chrome-store"` for analytics.
- [ ] **`og-image.png`** — 1200×630. This is the single highest-leverage asset here; it is
      what every shared link renders as.
- [ ] **`favicon.svg`**, **`apple-touch-icon.png`**, **`logo.png`** (referenced in schema).
- [ ] **Replace the CSS mock-ups** in the hero and the subtitles/bug sections with real
      screenshots or a short muted autoplay loop. Real product imagery lifts conversion, and
      `<img>` with descriptive alt text earns Google Images traffic that a CSS mock cannot.
- [ ] **`/privacy` and `/terms`** — linked in the footer, do not exist yet. The Chrome Web
      Store requires a privacy policy anyway.
- [ ] **Pricing** — the page and the schema both state free. If that changes, update
      `offers.price` in the JSON-LD to match, or the markup contradicts the page.
- [ ] **`lastmod`** in `sitemap.xml` whenever the content meaningfully changes.

## AEO and GEO — answer engines and AI search

Ranking in a list of blue links is now only part of the job. Two adjacent surfaces matter,
and the page was originally weak on both:

**AEO (answer engines)** — featured snippets, People Also Ask, voice assistants. These
extract a short, self-contained answer. The `FAQPage` schema was already the main asset
here; what was missing was a plain definitional statement. The hero says *"Every click
becomes a zoom"*, which sells well to a human and gives an extractor nothing. The
**In short** block now opens with a literal `X is a Y that does Z` sentence, followed by
nine key/value fact rows — the shape extractors lift most reliably. `speakable` schema
points voice assistants at that same paragraph.

**GEO (generative engines)** — ChatGPT Search, Perplexity, Claude, Google AI Overviews.
Being cited by these depends on three things, in order:

1. **Their crawlers being allowed.** This is binary and easy to get wrong by accident.
   `robots.txt` now names ten AI agents explicitly and allows them. Note that
   retrieval bots (OAI-SearchBot, PerplexityBot, ClaudeBot) are separate from *training*
   crawlers (GPTBot, CCBot) — you can refuse training while keeping citation reach, and
   the file explains that trade-off inline so the decision is a choice rather than a
   default.
2. **Extractable, specific claims.** Generative engines quote sentences with concrete
   detail — "MP4 (H.264 + AAC) or WebM (VP9 + Opus)" beats "multiple export formats".
   The fact rows and the comparison table are both built for this.
3. **Entity clarity.** An engine must be able to tell this product from every other tool
   with a similar name. `Organization.sameAs`, `WebPage.about`, `mentions` and a
   `dateModified` now do that work. **The `sameAs` entry is a placeholder** — replace it
   with the real Chrome Web Store URL, and add GitHub or X if they exist. A `sameAs`
   pointing at a 404 is worse than none.

**`llms.txt`** is also now at the root. It is a proposed convention rather than a ratified
standard, and no engine is documented as requiring it — it costs one small file, and it is
the only place the product's full factual profile exists in one clean, unstyled block.
Keep it in sync with the page; a contradiction between them is worse than omitting it.

What none of this can do is manufacture citations. Generative engines lean heavily on
third-party corroboration — a roundup article, a Product Hunt entry, a Reddit thread that
names the tool. On-page work makes you *quotable*; being mentioned elsewhere is what makes
you *quoted*.

## What actually determines whether you rank

Being straight about this: **a landing page cannot rank on its own.** On-page work is the
part you fully control and it is now done well, but it is maybe a third of the outcome. The
rest:

1. **Chrome Web Store listing.** For extension queries the store listing often outranks the
   marketing site — it inherits google.com's authority. Put the same keywords in the listing
   title and the first two lines of the description, and treat it as your most important SEO
   surface, not an afterthought.
2. **Links.** The reason Cursorful ranks is partly age and partly citations. Realistic
   sources: Product Hunt, the roundup articles that already rank for these terms (several
   exist — ask to be added), Reddit and Hacker News where the *offline/no-upload* angle is
   genuinely interesting, and dev newsletters for the HAR angle.
3. **Content depth.** One page competes for one cluster. The obvious next pages, each
   targeting a query the landing page can only mention:
   - `/vs-cursorful` — comparison pages rank fast and convert well
   - `/online-video-editor` — the editor now works standalone with no install, which is
     a genuinely searchable proposition ("free online video editor no signup", "trim
     video in browser"). It needs its own marketing page that links *into*
     `/editor/editor.html`; the tool itself stays `Disallow`ed because it is an app
     shell with no copy to rank on
   - `/screen-recorder-with-subtitles`
   - `/bug-report-screen-recorder`
   - `/how-to-record-a-product-demo`
4. **Verify and measure.** Google Search Console (submit the sitemap), then check the
   [Rich Results Test](https://search.google.com/test/rich-results) and
   [PageSpeed Insights](https://pagespeed.web.dev/) against the live URL. All three are free
   and will tell you more than any assumption here.

## Honest expectations

Nobody can promise a #1 ranking, and any tool or agency that does is selling something. What
is reasonable: the intersection queries in tier three are largely uncontested, so those
should come within weeks of indexing plus a handful of links. The head term
*"screen recorder with automatic zoom"* has six established competitors and will take
sustained content and link work — plan in quarters.

The strongest asset here is not a keyword. It is that the product genuinely does something
none of the competitors do, and the page says so plainly and checkably.
