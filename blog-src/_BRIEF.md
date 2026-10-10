# Blog writing brief — Click & Record (clickandrecord.tech)

## Output format (STRICT)
One file per post: /Users/danusabu/clickandrecord/blog-src/<slug>.html

The file starts with a JSON metadata block inside an HTML comment, then the body HTML:

<!--meta
{
  "slug": "how-to-make-a-product-demo-video",
  "title": "How to Make a Product Demo Video (Step-by-Step)",   // <title>, 40–60 chars, primary keyword near the front
  "h1": "How to make a product demo video that people actually finish",  // can differ from title
  "description": "…",            // meta description, 140–158 chars, includes primary keyword, no quotes
  "keyword": "product demo video",   // primary target query
  "category": "Product demos",    // one of: Product demos | Recording techniques | Bug reports & QA | Subtitles & editing | Comparisons & use cases
  "faq": [ {"q": "…?", "a": "…"} , … ],   // exactly 3–4 Q&As, plain text (no HTML), answers 1–3 sentences
  "related": ["slug-a", "slug-b", "slug-c"]   // 3 slugs from the master list below
}
-->
<p>Intro paragraph…</p>
<h2>…</h2>
…

Body rules:
- Allowed tags only: p, h2, h3, ul, ol, li, strong, em, a, code, blockquote, table/thead/tbody/tr/th/td. No h1 (the template renders it), no FAQ section (the template renders "faq" from metadata — do NOT repeat it in the body), no images, no inline styles, no classes, no scripts.
- Length: 900–1,400 words of body. Real substance: concrete steps, numbers where genuinely true, checklists. No fluff, no "In today's fast-paced digital world".
- Open with a 2–3 sentence paragraph that directly answers the search intent (answer engines lift this). Include the primary keyword in the first 100 words, in at least one h2, and naturally a few more times. Use related secondary phrases.
- 4–7 h2 sections, h3 where useful. At least one list. A table where it genuinely helps (comparisons, specs).
- Product mentions: Click & Record should appear as the recommended tool where it fits, but the post must be useful even to someone who never installs it. Roughly 20–30% of the post about the product, max. One natural mid-post mention + a closing paragraph is plenty — the template adds its own CTA box at the end, so don't write "Add to Chrome" buttons.
- Internal links (mandatory): at least 3 links to other posts as <a href="/blog/<slug>">anchor</a> using slugs from the master list, plus at least one of: <a href="/">Click &amp; Record</a> or <a href="/editor/editor.html">the free browser editor</a>. External links only to authoritative docs (MDN, Chrome developers, W3C, GitHub docs) and only when really useful; add rel="noopener".
- Escape & as &amp; in HTML text.
- Voice: plain, confident, specific, second person. US English. Short paragraphs. No emoji. No exclamation marks.

## Truthfulness (NON-NEGOTIABLE)
Only claim what is in the fact sheet below. Do NOT invent features (no blur/redaction tool, no cloud sharing links, no team workspace, no AI voiceover, no Mac app, no Firefox/Safari support, no cursor smoothing claims, no pricing tiers). Do NOT invent statistics, studies, survey numbers, customer names, testimonials or quotes. For competitors, describe only well-known, stable facts and hedge ("at the time of writing — check their site for current pricing"); never disparage, never state their prices as fact. If a general best-practice number is used (e.g. "keep demos under 2 minutes"), present it as advice, not as research.

## Fact sheet: Click & Record
- Free Chrome extension (also works in Edge and Brave, Chromium 116+). No account, no sign-up, no watermark. Chrome Web Store: https://chromewebstore.google.com/detail/lfpnagkdegnjjghefcbpeoblgoaklnnn
- Records a browser tab, any application window (including non-Chrome apps), or a whole display. Optional microphone and webcam.
- Automatic zoom: every click is logged (position + timestamp) during recording and turned into a zoom keyframe afterwards. Zooms are a post-process, not baked in — each can be retimed, made stronger/weaker, re-aimed or deleted, and you can add manual zooms. Clicks inside an in-flight zoom are skipped so bursts don't stack; nearby zooms link so the camera pans while zoomed instead of pulsing in and out. Typing bursts hold the zoom while you type (only timing is recorded, never what you typed).
- Click zoom works for all three sources, but an extension only sees clicks inside web pages — clicks in other desktop apps produce no automatic zoom (manual zooms still work).
- 3-2-1 count-in happens before recording starts, so it's not in the file. Pause/resume. Stop from the toolbar icon or Alt+Shift+S.
- Crash recovery: the recording is written to local disk continuously; if the browser or extension crashes mid-take, the popup offers to recover it.
- Subtitles: a Whisper speech model ships inside the extension and runs locally in the browser (WebAssembly). No API key, no per-minute cost, no upload, works offline. Two model sizes (faster / more accurate), word-level timings, editable cues, hand-written cues, export SRT or VTT sidecar files.
- Network & console capture (optional, tab recordings only): requests and console lines are timestamped against the video; clicking a row seeks the video to that moment. Export a standard HAR 1.2 file (opens in Chrome DevTools, Charles, etc.) and "Copy as cURL". Does not use chrome.debugger, so no "is debugging this browser" banner and DevTools stays usable.
- Webcam is recorded as a separate track, so the bubble can be moved, resized, restyled or hidden after recording.
- Editor: trim, split, delete sections, per-clip speed 0.5x–4x, append extra clips, backgrounds (gradient or your own image), inset/padding, corner radius, shadow, mock macOS or Windows browser frame with an editable URL bar (so you can change/hide the real URL), crop, letterbox detection.
- Export: MP4 (H.264 + AAC) or WebM (VP9 + Opus), quality presets; the dialog shows resolution, bitrate and estimated file size before exporting. Aspect ratios 16:9, 9:16, 1:1, 4:5 or source. Export renders faster than real time in supported browsers. Optional "Save to Google Drive" (drive.file scope).
- The editor also works standalone without installing: https://clickandrecord.tech/editor/editor.html — open any video file on disk and use trim, split, speed, manual zooms, on-device subtitles, backgrounds, frames, crop, aspect ratios, MP4/WebM export. Only recording and *automatic* click zoom need the extension.
- Privacy: recording, editing, transcription, export all run locally. Nothing uploaded unless the user clicks Save to Google Drive. No analytics, no cookies.
- Positioning: auto-zoom recorders (e.g. Cursorful, Screen Studio [macOS app], Zumie) make polished video but capture nothing about what the page was doing; bug-report recorders (e.g. Jam, Bird Eats Bug, PlayLog) capture logs but produce plain video. Click & Record does both from one take, plus on-device subtitles.

## Master list of slugs (use for internal links / related)
Product demos: how-to-make-a-product-demo-video, saas-demo-video-best-practices, product-hunt-launch-video, how-to-record-a-website-walkthrough, feature-announcement-video, saas-onboarding-video, vertical-screen-recording-reels-shorts-tiktok, linkedin-product-demo-video, async-sales-demo-video, landing-page-hero-video
Recording techniques: what-is-an-auto-zoom-screen-recorder, how-to-zoom-in-on-a-screen-recording, zoom-on-click-screen-recorder-chrome, how-to-record-a-chrome-tab, record-a-window-or-full-screen-in-chrome, screen-recording-tips-for-crisp-video, record-screen-and-webcam-together, free-screen-recorder-no-watermark, screen-recorder-no-account, mp4-vs-webm-screen-recording
Bug reports & QA: how-to-write-a-bug-report-with-video, screen-recorder-that-captures-network-requests, what-is-a-har-file, record-console-logs-with-screen-recording, copy-as-curl-reproduce-api-bugs, qa-testing-screen-recording-workflow, customer-support-screen-recordings, bug-reproduction-steps-video, share-network-logs-with-developers, attach-video-to-github-issue
Subtitles & editing: add-subtitles-to-screen-recording-free, offline-video-transcription-in-browser, srt-vs-vtt-subtitles, accessible-tutorial-videos-captions, private-screen-recorder-no-upload, trim-and-split-video-in-browser, speed-up-screen-recording, add-background-and-browser-frame-to-screen-recording, hide-sensitive-information-in-screen-recordings, reduce-screen-recording-file-size
Comparisons & use cases: cursorful-alternative, screen-studio-alternative-windows-chrome, loom-alternative-no-account, best-free-screen-recorders-for-chrome, auto-zoom-screen-recorders-compared, screen-recording-for-teachers-and-online-courses, record-software-tutorial-for-youtube, video-for-developer-documentation, async-video-updates-for-remote-teams, chrome-extension-screen-recorder-vs-desktop-app
