# Deploying the editor

Only the **editor** is hosted. The extension stays loaded locally in Chrome (or goes
to the Web Store separately). The hosted page holds **no recordings** — it pulls them
out of your local extension through `bridge.html` at runtime — so publishing it
leaks nothing.

What ships is the `site/` folder, which contains exactly the public surface —
landing page, editor, fonts and models. There is nothing to exclude.

## What to zip, what to host

The repo is physically split into the two things you ship:

```
extension/   → zip the CONTENTS of this folder, upload to the Chrome Web Store
site/        → push this folder to GitHub and serve it with GitHub Pages
```

Each folder is self-contained — `fonts/` exists in both on purpose, so neither reaches
outside itself. The docs at the repo root ship nowhere.

### The extension zip

Zip the folder's *contents*, not the folder: `manifest.json` must sit at the root of the
archive or Chrome rejects it. From the repo root, on Windows:

```powershell
Compress-Archive -Path extension\* -DestinationPath extension.zip -Force
```

~0.3 MB. Before publishing, set `DEFAULT_EDITOR_BASE_URL` in `extension/background.js`
to your deployed origin — it points at `http://localhost:3000` for development, which is
broken for everyone else — and confirm that origin appears in BOTH
`extension/manifest.json` (`web_accessible_resources` matches) and
`extension/bridge.js` (`ALLOWED_PARENT_ORIGINS`).

Note that an unpacked extension's ID is derived from its path, so the move into
`extension/` gives your dev install a **new extension ID**. If Drive OAuth suddenly
fails with `redirect_uri_mismatch`, that's why — re-check the redirect URI.

### The site on GitHub Pages

```sh
cd site
git init && git add -A && git commit -m "site"
git remote add origin <your-repo-url>
git push -u origin main
# then: repo Settings → Pages → deploy from branch main, root
```

Three GitHub-specific facts, all already handled but worth knowing:

- **GitHub refuses any file over 100 MB.** The Accurate model's 157 MB decoder cannot
  be pushed at all, and Git LFS is no way out — Pages serves LFS files as pointer
  stubs. `site/.gitignore` therefore excludes that model, and the editor probes for
  it at startup and simply doesn't offer "Accurate" when it's absent. Hosted
  transcription is the Fast model; Accurate remains available in a bundled build.
- The Fast decoder is 54 MB, which is over GitHub's 50 MB *warning* threshold — the
  push prints a complaint but succeeds.
- `site/CNAME` contains `clickandrecord.tech`, which is how Pages binds the custom
  domain. **The site must be served at a domain root** (custom domain or
  `username.github.io`), because `index.html` uses root-relative asset paths — as a
  project page under `/repo-name/` the fonts would 404.

### Using the Accurate model

Three ways, in increasing order of effort:

1. **Locally — it already works.** `site/.gitignore` keeps the model out of *git*, not
   off your disk. Serve `site/` on localhost and the editor's probe finds both models,
   so "Accurate" is offered as normal. Nothing to do.
2. **Bundled build.** Copy `site/editor` and `site/vendor` into `extension/`, set
   `DEFAULT_EDITOR_BASE_URL = ''`, zip. Both models ship inside the extension and work
   fully offline. ~340 MB, well under the Chrome Web Store's 2 GB cap — the cost is
   review time and a fatter install, not a hard limit.
3. **Split hosting.** Keep the site on GitHub Pages and serve only the weights from a
   host without a per-file cap (Cloudflare R2, S3 + CloudFront, any VPS — not Vercel or
   Cloudflare Pages, which have their own limits). Upload the *contents* of
   `site/vendor/models/` so the bucket has `whisper-…-timestamped/…` at its root, allow
   CORS `GET` and `HEAD` from your site origin, then set one constant in
   `site/editor/editor.js`:

   ```js
   const MODEL_BASE_URL = 'https://models.clickandrecord.tech/';  // trailing slash
   ```

   The availability probe and the worker both use it, so "Accurate" reappears the
   moment the bucket answers. R2 is the cheap pick: no egress fees, and ~330 MB of
   storage is pennies.

### Bundling the editor into the extension instead

If you want the fully-offline variant, copy `site/editor` and `site/vendor` into
`extension/` before zipping and set `DEFAULT_EDITOR_BASE_URL = ''`. That package is
~338 MB and every editor fix means a new store review — hosted is the better default.

## First decide: where do the model files come from?

This is the one real decision, and it changes the deploy size by two orders of
magnitude.

**The reason `vendor/` exists is an extension-only constraint.** MV3 forbids
extension pages from loading remote scripts, which is why transformers.js and the
Whisper weights are committed. A page on *your own domain* is an ordinary web page
with no such restriction — it can pull both from a CDN.

| | Self-hosted `vendor/` | CDN at runtime |
| --- | --- | --- |
| Deploy size | ~355 MB (both models) or ~180 MB (Fast only) | ~10 KB |
| Third-party requests | none | jsDelivr + huggingface.co on first use |
| Works offline | yes, once cached | no |
| Per-file host limits | the 157 MB decoder is the problem (see below) | not an issue |

Self-hosting keeps the "nothing phones home" property that motivated vendoring in
the first place; the CDN route trades that for a trivial deploy. **Audio never leaves
the machine either way** — only the model weights travel.

To switch to the CDN route, in `editor/transcribe.worker.js` import from
`https://cdn.jsdelivr.net/npm/@huggingface/transformers@3` instead of the local file,
set `env.allowRemoteModels = true`, drop the `localModelPath`/`wasmPaths` overrides,
and use a HuggingFace model id (`onnx-community/whisper-base.en_timestamped`). Then
delete `site/vendor/`. **Note this only works for the hosted copy** — the
extension's bundled editor still needs the vendored files, so don't delete them.

### Per-file size limits matter if you self-host

Two models are vendored now, and the larger one's decoder is the binding constraint:

| File | Size |
| --- | --- |
| `whisper-small.en-timestamped/onnx/decoder_model_merged_quantized.onnx` | **157 MB** |
| `whisper-small.en-timestamped/onnx/encoder_model_quantized.onnx` | 92 MB |
| `whisper-base.en-timestamped/onnx/decoder_model_merged_quantized.onnx` | 54 MB |
| `whisper-base.en-timestamped/onnx/encoder_model_quantized.onnx` | 23 MB |

Check your host's per-file limit before committing to it — **Cloudflare Pages caps
files at 25 MiB and will reject even the base encoder.** Verify the current limits for
whichever host you choose rather than trusting this table to stay accurate; this is the
constraint that decides the question.

**Shipping only the Fast model** is the middle option if size is the problem: add
`vendor/models/whisper-small.en-timestamped/` to your deploy's ignore list (on GitHub
it already is, via `site/.gitignore`) and drop the
`accurate` entry from `MODELS` in `editor/transcribe.worker.js`. The hosted editor then
carries ~180 MB and offers one model; the bundled extension copy is unaffected, since it
reads the files from disk.

## Deploying to Vercel

Two ways in, with one important difference.

**Git integration (the usual flow).** Push the repo to GitHub, import it in the Vercel
dashboard, and set **Root Directory = `site`** in the project settings. Every push
deploys. `site/vercel.json` is picked up automatically (`cleanUrls: false` is the line
that keeps `?session=` alive — do not lose it). Configure the domain in the Vercel
dashboard; the `CNAME` file is a GitHub-Pages mechanism and is ignored here (it deploys
as a harmless static file).

Because this path goes *through GitHub*, the Accurate model cannot ride along no matter
what Vercel would accept: GitHub rejects any file over 100 MB at push, which is why
`site/.gitignore` excludes it. The deployed editor offers the Fast model and hides
Accurate automatically.

**CLI deploy (bypasses GitHub).** `cd site && npx vercel --prod` uploads the folder
directly. Vercel's static-file limit is **100 MB on Hobby, 1 GB on Pro** — so on the
Hobby plan the 157 MB Accurate decoder still fails, but on **Pro, a CLI deploy can
carry the full model set**. The trade: deploys become a manual command instead of a
git push, and the ignore rule keeps the model out of git either way (temporarily use
`vercel --prod` with the file present locally; the CLI uploads what is on disk, not
what git tracks).

Summary for the Accurate model on Vercel:

| Flow | Plan | Accurate available to users? |
| --- | --- | --- |
| GitHub → Vercel | any | **No** — GitHub blocks the file before Vercel sees it |
| `vercel --prod` from `site/` | Hobby | No — 100 MB static-file limit |
| `vercel --prod` from `site/` | Pro | **Yes** — 1 GB static-file limit |
| Either flow + `MODEL_BASE_URL` on R2/S3 | any | **Yes** — weights come from the bucket |

`vercel.json` is already set up with the two things that matter:

- **`cleanUrls: false`** — clean-URL rewrites redirect `/editor/editor.html` to
  `/editor/editor` and **drop the query string**, which strips `?session=` and
  breaks the editor completely. This exact bug already happened locally with
  `serve`. Whatever host you use, confirm query strings survive.
- **Long-lived caching for `/vendor/`**, so the weights (77 MB for Fast, 252 MB for
  Accurate) are fetched once per model actually used,
  and no caching for `/editor/`, so code changes take effect immediately.

For a custom domain (e.g. `editor.retailcloud.com`), add it in the Vercel dashboard
and point a CNAME at Vercel.

## Then point the extension at it

Three places need the new origin. Miss any one and it fails:

1. **`background.js`** — set `DEFAULT_EDITOR_BASE_URL` to
   `https://editor.example.com`, or leave the code alone and set it at runtime:
   ```js
   chrome.storage.local.set({ editorBaseUrl: 'https://editor.example.com' })
   ```
2. **`manifest.json`** — add the origin to the `web_accessible_resources` entry that
   exposes `bridge.html`.
3. **`bridge.js`** — add it to `ALLOWED_PARENT_ORIGINS`.

The last two are the security boundary: **any origin listed there can read
recordings out of the extension.** Keep the lists narrow and specific — no
wildcards broader than a subdomain you control. `localhost`, `127.0.0.1` and
`*.retailcloud.com` are already allowed.

Reload the extension afterwards, then record something and confirm the editor opens
on the new domain and the recording loads (that proves the bridge handshake works
cross-origin).

## Do not set COEP/COOP headers

It's tempting, because `Cross-Origin-Embedder-Policy: require-corp` unlocks
multi-threaded WASM via `SharedArrayBuffer` and would speed transcription up.
**Don't** — COEP blocks the `chrome-extension://` bridge iframe, and without the
bridge the hosted editor can't load recordings at all. Single-threaded WASM is
already adequate (~27 s for a short clip).

## Checklist

- [ ] Editor opens at `https://…/editor/editor.html?session=…&ext=…`
- [ ] Query string intact (no redirect stripped it)
- [ ] Recording loads — proves the bridge works from the new origin
- [ ] Subtitles generate (proves `vendor/` is reachable, if self-hosting)
- [ ] Export produces a file
- [ ] Save to Drive still works (its OAuth redirect is unrelated to this origin)
