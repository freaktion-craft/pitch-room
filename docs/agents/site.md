# The download page (pitchroom.dev)

`site/index.html` is one static file, plus `site/favicon.svg`, `site/img/installer-icon.png` and `site/img/og.png`
(the link preview: the name, 88 px Geist Serif, centred on the page's dark with blueprint lines round it, 1200 × 600,
named in the `og:` tags; 2:1, as KakaoTalk crops anything else itself; bump its `?v=` when it changes). No build step.
Fonts (Pretendard, Geist Serif) load from cdn.jsdelivr.net.

## What it does

- Picks the installer for the visitor's system from the newest **published** release of the public
  `freaktion-craft/pitchroom-releases` repo that has one, through the GitHub API (the last 30 releases): a release may be
  Windows' only, so Mac can be a few versions behind.
- Under the button, that file's version (from its name, else the tag) and how long ago it came out, e.g. `v1.0.28 · 18
  hours ago` (`18시간 전` in Korean; `ago()`). Not shown on a phone, an unknown OS, or when the API fails (it allows 60
  calls an hour per address).
- `FILES` holds the file regexes: macOS arm64 and x64 `.dmg`, Windows `pitchroom_install.exe` (or the older
  `-win-x64.exe` name).
- `detectOS` and `detectMacArch` (userAgentData, else the WebGL renderer, else arm64) choose the file.
- An inline script swaps the button's `href` to the asset's download URL. On a phone, an unknown OS, offline or when
  rate-limited, the link stays on the releases page.
- Phones and tablets see "Please visit from a desktop". Korean copy when the browser language starts with `ko`.
- A "Downloading…" tip and a flying animation aim at the browser's downloads icon with fixed offsets per browser.
- The version line under the button tries to follow it (`fall()`, its numbers in `FALL`): each letter is pulled on an
  elastic after the flying dot, lets go from the left, falls and lands on the foot line's letters or the window's bottom
  edge, and lies there tipped. On load it blurs in with the button. Reduced motion skips both.
- Dark only. A few app tokens are copied inline and must be kept in step with `css/tokens.css` by hand.

Because it reads the published releases, a release needs no site change. Renaming the installer does: update `FILES`
too. After a Windows-only release, Mac visitors get the last `.dmg` (`desktop-and-release.md`); with none in the last 30
releases, the button stays on the releases page.

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
