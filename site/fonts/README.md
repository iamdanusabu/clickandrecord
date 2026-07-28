# fonts/

Typefaces, committed rather than fetched — the same rule the rest of this repo follows
(see `vendor/README.md`). The extension, the editor and the landing page all load them from
here, so everything looks identical on a machine that has never heard of these fonts, and
works with the network disconnected.

| File | Bytes | Covers | Used by |
| --- | --- | --- | --- |
| `inter-latin.woff2` | 48 KB | Latin, weights 400–700 | extension UI + landing body text |
| `inter-latin-ext.woff2` | 85 KB | Latin Extended, weights 400–700 | extension UI |
| `archivo-latin.woff2` | 88 KB | Latin, weights 400–700, **width axis 75–125%** | landing page display type only |

Archivo is the landing page's voice: a grotesque with a real width axis, set expanded
(`font-stretch: 112%`) and tight-tracked at display sizes. The extension itself does not
load it — the app is set entirely in Inter, and the site borrows Inter for running text so
the two share a reading texture without the site sounding like the app.

All three are **variable** fonts spanning 400–700 in a single file, which is why three
files cover every weight the site and app use. 221 KB total, and none of it is fetched at
runtime from a third party.

Source: Google Fonts, both under the SIL Open Font License 1.1 — Inter v20 and Archivo v25.
To update, request the CSS with a current Chrome user-agent; the URLs it returns are the
woff2 subsets. Note the `wdth` axis in the Archivo request — omit it and you get a
fixed-width cut, and the display type quietly loses its expansion:

```
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
curl -A "$UA" "https://fonts.googleapis.com/css2?family=Inter:wght@400..700&display=swap"
curl -A "$UA" "https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@75..125,400..700&display=swap"
```

Send an old user-agent and Google serves `.ttf` instead — several times the size for
the same glyphs.

## Who references these

This folder exists twice — once in `extension/` and once in `site/` — so that each
shippable folder is self-contained. Keep the copies identical; they are small enough
that duplication beats a cross-folder dependency. Within each, paths are relative to
the stylesheet: `site/editor/editor.css` uses `../fonts/`, `extension/popup.css` and
`extension/permission.css` use `fonts/`, and `site/index.html` uses root-relative
`/fonts/` (which is why the site must be served at a domain root).

`font-display: swap` is deliberate. The fallback stack is Segoe UI Variable on
Windows 11 and `-apple-system` on macOS — close enough in metrics that a swap isn't
a jarring reflow, and showing text immediately beats a blank panel.
