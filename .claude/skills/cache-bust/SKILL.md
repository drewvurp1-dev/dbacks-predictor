---
name: cache-bust
description: Bump the ?v=N cache-bust version on the right index.html entry tag(s) after changing shipped frontend files. Use after editing anything under public/js, public/css, or league-hub/public, or before opening a PR that touches the frontend, to avoid users getting stale cached assets.
---

# Cache-bust guard

Snake Savant has **no build step** — browsers cache assets by URL, so a shipped
frontend change only reaches users when its entry tag's `?v=N` is bumped in
`index.html`. This is easy to forget and fails *silently* (stale code in the
field, no test catches it). This skill makes the bump deterministic.

## Versioning scheme

Only the **entry points** are versioned, not every file:

| Changed file | Bump this tag | In |
|---|---|---|
| `public/css/*.css` | `style.css?v=` | `public/index.html` |
| `public/js/charter.js` | `charter.js?v=` | `public/index.html` |
| any other `public/js/**/*.js` (incl. `ui/*.js`) | `app.js?v=` | `public/index.html` |
| `league-hub/public/css/*.css` | `style.css?v=` | `league-hub/public/index.html` |
| `league-hub/public/js/*.js` | `app.js?v=` | `league-hub/public/index.html` |

Why `app.js` for any module: `app.js` is the ES-module graph entry; all the
other modules (`player.js`, `predict.js`, `ui/dashboard.js`, …) are imported
through it with **unversioned** paths, so bumping the entry is what actually
busts the whole graph. `charter.js` is a separate classic script and is
versioned on its own.

Excluded (never trigger a bump): `*.test.js`, `sw.js` (service worker
self-updates), `manifest.webmanifest`, and `index.html` itself.

## How to run

From the repo root:

```bash
# See what would bump without changing anything (use this first):
bash .claude/skills/cache-bust/bump.sh --check

# Apply the bumps:
bash .claude/skills/cache-bust/bump.sh
```

Pass a base ref as the last arg if not comparing against `origin/main`, e.g.
`bash .claude/skills/cache-bust/bump.sh HEAD~1`.

The script is **idempotent**: it only bumps a tag whose live `?v=` still equals
the base ref's value, so re-running (or running after you already bumped by
hand) is a safe no-op. It computes changed files as the union of
committed-vs-base, staged, and unstaged changes.

## When to use it

- Right before committing/opening a PR that touched any frontend file.
- As a final check in the `prsm` flow.

After it bumps, include the `index.html` change in the same commit/PR as the
frontend change it covers.
