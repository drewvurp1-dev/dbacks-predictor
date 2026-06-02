#!/usr/bin/env bash
# Cache-bust guard for Snake Savant.
#
# Detects which shipped frontend files changed on this branch and bumps the
# matching `?v=N` entry tag(s) in the appropriate index.html. Idempotent:
# re-running after a bump is a no-op (it compares the current tag version
# against the base ref and only bumps tags still sitting at the base value).
#
# Usage:
#   bump.sh [BASE_REF]      # BASE_REF defaults to origin/main (falls back to main)
#   bump.sh --check [BASE]  # report what WOULD bump, change nothing (exit 1 if any)
#
# Versioning scheme (see CLAUDE.md "Cache-bust"):
#   Main app  -> public/index.html
#     public/css/*.css            -> bump style.css?v=
#     public/js/charter.js        -> bump charter.js?v=   (classic script)
#     public/js/**/*.js (others)  -> bump app.js?v=       (ES-module graph entry)
#   League hub -> league-hub/public/index.html
#     league-hub/public/css/*.css -> bump style.css?v=
#     league-hub/public/js/*.js   -> bump app.js?v=
#   Excluded: *.test.js, sw.js, manifest.webmanifest, index.html itself.

set -euo pipefail

CHECK_ONLY=false
if [[ "${1:-}" == "--check" ]]; then CHECK_ONLY=true; shift; fi

BASE="${1:-origin/main}"
if ! git rev-parse --verify --quiet "$BASE" >/dev/null; then
  if git rev-parse --verify --quiet main >/dev/null; then
    BASE=main
  else
    echo "warn: base ref '$BASE' not found and no 'main'; comparing against HEAD~1" >&2
    BASE="HEAD~1"
  fi
fi

# Union of: committed-vs-base, staged, and unstaged working-tree changes.
changed="$(
  { git diff --name-only "$BASE"...HEAD 2>/dev/null || true
    git diff --name-only --cached 2>/dev/null || true
    git diff --name-only 2>/dev/null || true
  } | sort -u
)"

needs_main_app=false main_charter=false main_css=false lh_app=false lh_css=false

while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  case "$f" in
    *.test.js) ;;                                    # tests aren't shipped
    public/css/*.css)            main_css=true ;;
    public/js/charter.js)        main_charter=true ;;
    public/js/*.js|public/js/ui/*.js) needs_main_app=true ;;
    league-hub/public/css/*.css) lh_css=true ;;
    league-hub/public/js/*.js)   lh_app=true ;;
  esac
done <<< "$changed"

bumped=()
needed=()

# bump_tag <index_file> <tag_basename>
# Bumps only if the live version still equals the base ref's version.
bump_tag() {
  local index="$1" tag="$2"
  local esc; esc="$(printf '%s' "$tag" | sed 's/[.]/\\./g')"
  local re="${esc}?v=\([0-9]\+\)"

  local cur; cur="$(grep -oE "${tag//./\\.}\?v=[0-9]+" "$index" | head -1 | grep -oE '[0-9]+$' || true)"
  if [[ -z "$cur" ]]; then
    echo "warn: no '${tag}?v=' tag found in $index — skipping" >&2
    return
  fi

  local base_ver
  base_ver="$(git show "$BASE:$index" 2>/dev/null \
    | grep -oE "${tag//./\\.}\?v=[0-9]+" | head -1 | grep -oE '[0-9]+$' || true)"

  if [[ -n "$base_ver" && "$cur" -gt "$base_ver" ]]; then
    return  # already bumped on this branch — idempotent skip
  fi

  needed+=("$index: ${tag}?v=${cur} -> $((cur + 1))")
  $CHECK_ONLY && return

  sed -i "s/${re}/${tag}?v=$((cur + 1))/" "$index"
  bumped+=("$index: ${tag}?v=${cur} -> $((cur + 1))")
}

$main_css     && bump_tag public/index.html style.css
$main_charter && bump_tag public/index.html charter.js
$needs_main_app && bump_tag public/index.html app.js
$lh_css       && bump_tag league-hub/public/index.html style.css
$lh_app       && bump_tag league-hub/public/index.html app.js

if $CHECK_ONLY; then
  if [[ ${#needed[@]} -eq 0 ]]; then
    echo "OK: cache-bust up to date (base: $BASE)"; exit 0
  fi
  echo "MISSING cache-bust (base: $BASE):"; printf '  %s\n' "${needed[@]}"; exit 1
fi

if [[ ${#bumped[@]} -eq 0 ]]; then
  echo "OK: nothing to bump (base: $BASE) — no shipped frontend changes, or already bumped."
else
  echo "Bumped (base: $BASE):"; printf '  %s\n' "${bumped[@]}"
fi
