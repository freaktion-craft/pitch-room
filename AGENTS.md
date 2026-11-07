Agents working in this repo: read [CLAUDE.md](CLAUDE.md) first. It holds the layout, how to run and check the app, the
owner's rules, and the git and release workflow. Topic docs are in [docs/agents/](docs/agents/).

The hard rules, in case you read nothing else:

- **No sound.** Never play audio through the speakers; check the page in offscreen, muted windows.
- **Hands off the owner's server and library.** Port 5178 serves their real songs and settings. Check on your own
  `server.py` port with `PITCHROOM_DATA` set to a scratch folder, never with `launch.py`. Don't drive their browser.
- **Heavy jobs one at a time** (audio models, whole-library scripts, benches, builds), at below-normal priority with
  capped threads. Ask before a fan-out.
- **Merges, releases and site deploys only on the owner's explicit yes.** Work on a branch; PRs to `main`.
- **Never commit `icons.local.js`** (Hugeicons Pro) or paste Pro icon paths anywhere.
- **Korean for every UI string** in `js/ko.js`, keyed by the exact English.
- Use the repo's `.venv` Python, never base Anaconda.
