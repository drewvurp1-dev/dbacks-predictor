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

Any Node host with a Postgres add-on works. Render's free tier is the shortest
path:

1. **New → Web Service**, point it at this repo.
   - Build: `npm install`
   - Start: `npm start`
2. **New → Postgres** (free tier). Copy its **Internal Database URL**.
3. Set the environment variables below on the web service.

The vote tables are created automatically on the first request, and the six
destinations are seeded then too. Nothing to run by hand.

> Render's free web services sleep after inactivity. The first person to open
> the link after a quiet spell waits ~30s for it to wake. If that matters, the
> paid tier removes it — or just warn the group.

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
2. Set a **title** and a **closes at** deadline. With a deadline set, the poll
   closes itself and emails you the results within five minutes of it passing —
   you don't have to be around. Leave it blank to close manually.
3. Share `https://your-app-url/vote/` with the group. One link for everybody;
   no accounts, no codes.
4. Watch ballots arrive on the admin page. The voter page shows *who* has voted
   so you can chase stragglers — never *what* they voted.
5. When you're ready, **Close & send results** (or let the deadline do it).

## 4. How privacy actually works

Voters enter a name — no passwords, as you asked. The protection is that the
server hands the browser a random **ballot token** on first claim, and that
token, not the name, is what opens a ballot afterwards. So:

- Typing someone else's name does **not** show you their ballot. You get
  "already started a ballot on another device."
- The public `/vote/api/poll` response contains no rankings, no counts, and no
  winner — before or after the close. There is deliberately no public results
  endpoint at all.
- Results come only from `/vote/api/admin/*`, behind `VOTE_ADMIN_KEY`.

The tradeoff of name-only entry: if someone clears their browser or switches
phones, they can't get back into their ballot. Use **Release a name** on the
admin page — it deletes that ballot so they can start over.

The honest limit: nothing stops a determined person voting twice under two
different names ("Drew" and "Drew V"). For a group trip that's fine, and it's
the price of not handing out access codes. The admin page lists every ballot by
name, so a duplicate would be obvious.

## 5. Things worth knowing

**Adding destinations mid-vote.** Anyone with a ballot can nominate one, and it
appears on everybody's ballot immediately. People who already voted get a note
telling them what was added and where it landed (bottom of their list) so they
can move it. Their submitted ballot stays valid either way — an unranked
destination simply scores nothing for them. You can turn nominations off with
the "Let voters add new destinations" checkbox.

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
