# Ranked-choice destination vote — setup

A private ranked-choice vote for picking the next group trip. Voters rank the
destinations, anyone can nominate a new one, and only you ever see the results.

- **Voter page** — `/vote/`
- **Organizer page** — `/vote/admin.html`

The winner is decided by **instant runoff**: the last-place destination is
eliminated each round and its ballots move to each voter's next surviving
choice, until something holds a majority of the ballots still in play. A second
**Borda** score is reported alongside it as a consensus check — when the two
disagree, the report says so, because that means the group is genuinely split
rather than agreed.

---

## What this needs that the trip docs don't

The Georgia doc is a single static file on GitHub Pages. This can't be, and the
reason is the privacy requirement: a static page has no way to keep a ballot
secret, because anything the page can read, a voter can read. Ballots live in
Postgres and are only ever released through admin endpoints. So the Express app
in this repo has to actually run somewhere.

---

## 1. Deploy

Any Node host with a Postgres add-on works. The app reads `PORT` from the
environment, so nothing needs configuring for that.

The vote tables are created automatically on the first request, and the six
destinations are seeded then too. Nothing to run by hand.

### Railway

1. **New Project → Deploy from GitHub repo**, pick this repo.
2. In the project, **Create → Database → Add PostgreSQL**.
3. On the *app* service → **Variables**, set `DATABASE_URL` to the reference
   `${{Postgres.DATABASE_URL}}` (type it literally — Railway resolves it), plus
   the rest of the variables below.
4. App service → **Settings → Networking → Generate Domain** to get a public URL.
5. Set `ROOT_REDIRECT=/vote/` so the bare domain opens the ballot. Without it,
   `/` serves the D-backs dashboard — this repo hosts both apps, and the vote
   lives under `/vote/`.

Railway doesn't idle-sleep, so there's no cold start for voters.

### Render

1. **New → Postgres** (free tier) first. Copy its **Internal Database URL**.
2. **New → Web Service** pointed at this repo, *same region as the database*.
   - Build: `npm install`
   - Start: `npm start`
3. Set the environment variables below on the web service.

> Render's free web services sleep after ~15 min idle. The first person to open
> the link after a quiet spell waits ~50s. Wake it yourself before sharing the
> link, or use the paid tier.

### A note on database SSL

`sslFor()` in `routes/vote.js` picks the SSL mode from the hostname, because
getting it wrong doesn't degrade — it refuses to connect:

- **Public hosts** (`*.render.com`, `*.neon.tech`, Railway's `*.rlwy.net` TCP
  proxy) require SSL.
- **Private networks** (`postgres.railway.internal`, Render's bare `dpg-xxxx-a`
  internal hostname, any single-label host) serve no TLS at all.

Both are handled automatically. `DATABASE_SSL=0` or `=1` forces it either way if
a provider ever breaks the pattern.

## 2. Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | **Yes** | Postgres connection string. Without it every vote route returns 503. |
| `VOTE_ADMIN_KEY` | **Yes** | Password for `/vote/admin.html`. Make it long — it is the only thing protecting the results. |
| `VOTE_RESULT_EMAIL` | For email | Where the results report is sent. Set it to your address. |
| `RESEND_API_KEY` | Email option A | Sends via Resend's HTTP API. Simplest — no SMTP settings. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | Email option B | Any SMTP server, including Gmail with an app password. |
| `MAIL_FROM` | Optional | From address. Defaults to `SMTP_USER`, or Resend's sandbox sender. |
| `VOTE_POLL_ID` | Optional | Namespaces the poll (default `trip`). Change it to run a second, separate vote. |
| `DATABASE_SSL` | Optional | Set to `0` to disable SSL for a local Postgres. Auto-detected for localhost. |
| `ROOT_REDIRECT` | Recommended | Set to `/vote/` on a host dedicated to the vote, so the bare domain lands on the ballot instead of the D-backs dashboard. Leave unset locally. |

Push notifications reuse the app's existing setup — if `VAPID_PUBLIC_KEY`,
`VAPID_PRIVATE_KEY` and `SYNC_KEY` are already configured, you'll also get a
phone notification when the vote closes. If they aren't, email still works and
the push is skipped.

### Email: which option

**Resend** is the one to pick. Sign up, verify an address, create an API key,
set `RESEND_API_KEY`. No SMTP settings, and it doesn't break when Google changes
its policies.

**Gmail** works but needs an *app password* (Google account → Security →
2-Step Verification → App passwords), not your normal password:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASS=<16-character app password>
```

If neither is set, nothing breaks — the poll still closes and the results are
still on the admin page. The email is just skipped, with a warning in the logs.

## 3. Run the vote

1. Open `/vote/admin.html`, enter your `VOTE_ADMIN_KEY`.
2. Set a **title**, a **subtitle** (trip dates), and the three dates:
   - **Voting opens at** — until this moment the poll runs in *nomination
     phase*: voters can only suggest destinations, and the ranking UI does not
     exist for them. Leave blank to allow ranking straight away.
   - **New destinations close at** — nominations shut. Leave a gap before the
     opening and that gap is your **grace window**: suggestions are frozen,
     voting hasn't started, and you can prune duplicates from the Destinations
     list knowing the field can no longer move. Voters see "suggestions are in,
     voting opens at …" with no form and no ranking UI. Set it to the same
     instant as the opening if you don't want a window.
   - **Voting closes at** — the poll closes, the tally runs, and the report is
     emailed and pushed to you within five minutes, whether or not you're around.

   Splitting nomination from ranking is the point: everyone ranks the same
   finished list, so nobody votes on Thursday and misses two destinations added
   on Friday.
3. Share `https://your-app-url/vote/` with the group. One link for everybody;
   no accounts, no codes.
4. Watch ballots arrive on the admin page. The voter page shows *who* has voted
   so you can chase stragglers — never *what* they voted.
5. When you're ready, **Close & send results** (or let the deadline do it).
6. Closing publishes the **reveal**: voters visiting `/vote/` now watch the
   runoff play out a round at a time — bars for each destination, last place
   struck through and knocked out, its votes visibly sliding into whoever those
   voters ranked next, until something clears a majority. It ends on the winner
   with the maths, and there's a "how does this work?" explainer underneath.

   It shows **counts only — never a ballot and never a voter's name**. Use
   **The reveal → Hide them** on the admin page if you'd rather announce it
   yourself before anyone can look.

## 4. How privacy actually works

Voters enter a name — no passwords, as you asked. The protection is that the
server hands the browser a random **ballot token** on first claim, and that
token, not the name, is what opens a ballot afterwards. So:

- Typing someone else's name does **not** show you their ballot. You get
  "already started a ballot on another device."
- While voting is open, the public `/vote/api/poll` response contains no
  rankings, no counts and no winner. Full results — including every ballot —
  come only from `/vote/api/admin/*`, behind `VOTE_ADMIN_KEY`.
- After the close, `/vote/api/results` shows everyone the round-by-round runoff
  so the winner is explainable. It carries **per-round counts only**: no
  ballots, no voter names, ever. Nobody learns what anyone else ranked.

**Editing a vote.** On the same phone nobody ever sees the name screen again —
the ballot reopens straight away and can be changed until voting closes.

To edit from a *different* device, the voter needs the optional **4-digit PIN**.
They can set one when they claim their name, or later from the "Another device"
box on their ballot. Name + PIN then reopens the ballot anywhere, with their
ranking intact; the most recent device wins, so the old one signs out.

The PIN is hashed with scrypt and a per-ballot salt, and five wrong attempts
lock that name for 15 minutes — a 4-digit PIN is only 10,000 combinations, so
without both of those it would be worth guessing.

If someone set no PIN and lost their device, use **Release a name** on the admin
page. That deletes the ballot so they can start over — their old ranking is
gone. The admin ballot list shows who has a PIN, so you can tell instantly
whether a "let me back in" message needs you at all.

The honest limit: nothing stops a determined person voting twice under two
different names ("Drew" and "Drew V"). For a group trip that's fine, and it's
the price of not handing out access codes. The admin page lists every ballot by
name, so a duplicate would be obvious.

## 5. Things worth knowing

**Nomination phase.** Before **Voting opens at**, `/vote/` shows a suggestion
page instead of a ballot: a Location field, a short selling point, the voter's
own suggestions so far, and a countdown to the opening. Each voter gets **2**
(`MAX_ADDS_PER_VOTER` in `routes/vote.js`); the form disappears once they're
used, and a nomination you remove hands that slot back.

**Nominations are blind.** During this phase `GET /vote/api/poll` returns an
empty `destinations` array and only an aggregate `destinationCount` — the names
are withheld from the response itself, not merely hidden in the page, so nobody
can read the field out of devtools. A voter sees only what they personally
added, via the token-authenticated ballot response. Everything appears the
moment voting opens.

That means **you** are the deduplicator: check the admin Destinations list
before voting opens and remove near-duplicates ("Tokyo" and "Tokyo, Japan") and
anything that shouldn't be there. Each row shows who added it. A voter who
happens to submit an exact duplicate is told so and does *not* lose a slot.

Nine people × 2 plus the seeded 6 is up to 24 destinations, and a 24-row ranked
ballot is miserable on a phone. In practice most people add nothing — but if the
field does balloon, prune the obvious non-starters from the admin Destinations
list before voting opens.

**Adding destinations mid-vote.** If you leave **Voting opens at** blank, or
after it passes, anyone with a ballot can nominate one and it
appears on everybody's ballot immediately. People who already voted get a note
telling them what was added and where it landed (bottom of their list) so they
can move it. Their submitted ballot stays valid either way — an unranked
destination simply scores nothing for them. Nominations stop at the
**new destinations close at** deadline, or immediately if you untick "Let voters
add new destinations"; either way ranking continues until voting closes.

**Timezones.** Both deadline fields are pickers in *your* browser's local time —
type the wall-clock time you mean and it is stored as UTC. Voters see each
deadline converted to their own timezone, so somebody voting from another state
sees the correct local moment rather than yours. Arizona does not observe DST,
so MST is UTC−7 year-round.

**Drafts don't count.** A ballot only counts once the voter hits Submit. Drafts
are visible to you on the admin page, flagged as not counted, so you can chase
them.

**Ties.** With an even number of voters the final round can tie. The tie is
broken on Borda points and the report says loudly that it happened. An odd
number of voters avoids it — worth aiming for if you can.

**Ballot order is shuffled per voter.** Each new ballot starts in a random
order, so the list's own ordering doesn't nudge everyone toward whatever sits at
the top.

**Re-running the vote.** Change `VOTE_POLL_ID` to a new value to start a clean
poll with fresh seeded destinations, leaving the old one intact in the database.

## 6. Local development

```bash
createdb tripvote
DATABASE_URL=postgres://localhost/tripvote \
VOTE_ADMIN_KEY=dev-key \
VOTE_RESULT_EMAIL=you@example.com \
npm start
```

SSL is disabled automatically for `localhost`. Then open
`http://localhost:3000/vote/`.

Tests:

```bash
npm test        # includes the tally engine and the report formatter
npm run lint
```

The tally engine (`lib/rcv.js`) is pure and covered by unit tests — including
the case where instant runoff and Borda pick different winners, exhausted
ballots shrinking the majority threshold, and tie-breaking. The UI and the
database layer are not unit-tested; smoke-test those in a browser.
