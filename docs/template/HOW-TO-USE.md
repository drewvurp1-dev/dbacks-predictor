# Trip Doc Template

A self-contained template for building trip-planning pages like the Georgia one.
Copy it, fill it in, done — no build step, no dependencies, one file.

---

## Starting a new trip

```bash
mkdir -p docs/osaka
cp docs/template/index.html docs/osaka/index.html
```

It'll publish at `https://<user>.github.io/<repo>/osaka/` once merged to `main`.

Then work through the checklist below.

---

## Checklist

Everything you must change is either in `[SQUARE BRACKETS]` or in the config block.
Search the file for `[` and you'll find all of it.

- [ ] `<title>` — shows in the browser tab
- [ ] **Trip config** (top of `<head>`) — `currency` and `perUSD`
- [ ] **Hero** — destination, dates, three stats
- [ ] **Tab bar** — rename or delete tabs; each `showTab('x', …)` must match a `<div id="x" class="section">`
- [ ] **Pre-trip brief** — entry rules, anything read-once
- [ ] **Day cards** — one per day
- [ ] **Getting There** — timetable and fallback routes
- [ ] **Getting Around** — transport cards and fare table
- [ ] **Activity tab** — rename it, or delete both the tab button and its section
- [ ] **Alternatives**, **Tips**, **Budget**
- [ ] **Footer**
- [ ] Delete any component you didn't use

### Two things that break quietly

1. **Tab id mismatch.** If a tab button says `showTab('foo', this)` and no section has `id="foo"`, the tab silently does nothing. Check every pair.
2. **Budget totals.** Nothing recalculates these. If you change a line item, re-add the summary column yourself — it's the easiest thing in the doc to leave wrong.

---

## Components

| Component | Class | Use for |
|---|---|---|
| Day card | `.day-card` | One collapsible day |
| Stop | `.stop` | A single place or activity within a day |
| Map pin | `.map-pin` | Link to Google Maps |
| Cost badge | `.stop-cost` | Price on a stop (`.free` for free things) |
| Instagram chip | `.ig-link` | Link to a reel or post |
| Day total | `.day-total` | Per-person cost for the day |
| Alert | `.alert` | Callout — `.alert-sage` for calmer/greener |
| Route card | `.route-card` | A travel option that isn't a timetable |
| Timetable | `.fare-table` | Flights, fares — add `.rec` to the recommended row |
| Alt card | `.alt-card` | An optional activity (`.wine` / `.gold` accents) |
| Tip | `.tip` | Practical advice, grouped under an `<h3>` |
| Budget group | `.budget-group` | One spending category |
| Converter | `.converter-card` | Currency converter — config-driven, don't edit |

### Tag colours

`.tag-culture` `.tag-food` `.tag-night` `.tag-ski` `.tag-event` `.tag-free`

### Day number accents

`.day-num` takes `.gold` or `.sage` to mark a day as special.
Drop the `<div class="day-line"></div>` on your **last** day so the timeline stops.

---

## Conventions worth keeping

These came out of building the Georgia doc, mostly by getting them wrong first.

**Collapse the days, and write real previews.**
A plain accordion just trades scrolling for clicking. What makes it work is the
morning/afternoon/evening preview: collapsed, you can compare day 3 against day 6
without expanding anything. The Georgia itinerary went from 10,777px to 3,477px.

**Use `<details>`, not JavaScript.**
Native `<details>` is keyboard-accessible for free, works if JS fails, and — importantly —
Chromium hides collapsed content with `content-visibility`, so browser find-in-page
still reaches inside it. A JS accordion breaks Ctrl+F, which matters for a doc you'll
consult on the road.

**Link videos, don't embed them.**
Instagram's embed script is heavy, renders a broken box if a post goes private, and
a dozen of them make the page slow on foreign mobile data — which is exactly when
you'll open it. Chips cost nothing and never break.

**Strip `?igsh=` from Instagram URLs.** It's a share token tied to your session.

**Put read-once content in the collapsed brief.**
Entry rules, flight-date math, group logistics — all things you read once while
planning and never again. Left expanded they push the actual itinerary off screen.

**Tables for times, prose for reasons.**
Times buried in paragraphs are unreadable. Put them in a `.fare-table` and use the
caption underneath for what the table can't say.

**Wrap tables in `.table-scroll`.**
Otherwise a wide table makes the whole page scroll sideways on a phone.

**Write the caveats down.**
The most useful lines in the Georgia doc are the ones admitting something is a
compromise — the night drive down a mountain, the market that's worse but closer,
the club that probably won't let you in. A doc that only lists upsides gets ignored
the first time reality disagrees with it.

**Say when you couldn't verify something.**
Opening hours, prices and door policies drift. Marking a number as unchecked is more
useful than quietly presenting a guess as fact.

---

## If you end up with several trips

Each page carries its own copy of ~780 lines of CSS. That's fine for a handful and
means every page is self-contained — you can email one, or open it offline with no
broken asset paths.

If you get to four or five and want a style fix to hit all of them at once, pull the
`<style>` block out to `docs/assets/trip.css` and link it instead. It's a
twenty-minute job and nothing else about the structure has to change. Not worth doing
before you need it.

You may also want `docs/index.html` to become a landing page listing the trips, with
each trip moving to its own folder. Worth knowing that changes the URL of anything
already shared.
