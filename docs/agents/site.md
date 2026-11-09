# The download page (pitchroom.dev)

`site/index.html` is one static file, plus `site/favicon.svg`, `site/img/installer-icon.png` and `site/img/og.png`
(the link preview: the name in Geist Serif, centred on the page's dark, 1200 × 630, named in the `og:` tags). No build
step. Fonts (Pretendard, Geist Serif) load from cdn.jsdelivr.net.

## What it does

- Picks the installer for the visitor's system from the latest **published** release of the public
  `freaktion-craft/pitchroom-releases` repo, through the GitHub API.
- `FILES` holds the file regexes: macOS arm64 and x64 `.dmg`, Windows `pitchroom_install.exe` (or the older
  `-win-x64.exe` name).
- `detectOS` and `detectMacArch` (userAgentData, else the WebGL renderer, else arm64) choose the file.
- An inline script swaps the button's `href` to the asset's download URL. On a phone, an unknown OS, offline or when
  rate-limited, the link stays on the releases page.
- Phones and tablets see "Please visit from a desktop". Korean copy when the browser language starts with `ko`.
- A "Downloading…" tip and a flying animation aim at the browser's downloads icon with fixed offsets per browser.
- Dark only. A few app tokens are copied inline and must be kept in step with `css/tokens.css` by hand.

Because it reads the latest published release, a release needs no site change. Renaming the installer does: update
`FILES` too. A Windows-only latest release has no `.dmg`, so Mac visitors land on a releases page without a Mac file
(`desktop-and-release.md`).

## Deploy

Only on the owner's explicit yes. By hand, with no git hook:

```
npx --no-install wrangler pages deploy site --project-name pitchroom --branch site/download-page
```

- The Cloudflare Pages production branch is literally named `site/download-page`. `--branch main` only makes a preview.
- Wrangler is expected to be installed and signed in already; don't sign in or create accounts.
- Check the live page with a cache-busting query, e.g. `https://pitchroom.dev/?v=<random>`.
- The deploy leaves a `.wrangler/` folder in the checkout. Don't commit it.

## Style

Commit subjects for this area start "Download page: ...". Platforms are Windows and macOS only; don't add Linux.
