#!/usr/bin/env python3
"""Walk a deployed destination vote through every phase, with pauses to look.

    python3 scripts/vote-dryrun.py https://your-app.up.railway.app YOUR_ADMIN_KEY

Drives the real deployment through nominate -> grace window -> voting -> closed
-> results reveal, stopping at each step so you can open the site and see what a
voter sees. It creates a handful of fake voters and ballots so the runoff has
something to chew on, then offers to remove them again.

Safety: refuses to run if anybody has already started a ballot, so it can't be
pointed at a live poll mid-vote by accident. Pass --force to override, and
--cleanup to only undo a previous run.

Safest of all is to run it against a throwaway poll: set VOTE_POLL_ID=dryrun on
the host, let it redeploy, run this, then remove the variable. The real poll
lives under a different poll_id and is never touched.
"""

import json
import sys
import urllib.request
import urllib.error
import datetime

FAKE = {
    "Dry Run Ana":  ["3", "1", "6"],
    "Dry Run Ben":  ["1", "2", "3"],
    "Dry Run Cleo": ["3", "5", "1"],
    "Dry Run Dan":  ["2", "1", "3"],
    "Dry Run Eve":  ["1", "3", "2"],
}
FAKE_DESTS = [
    ("Dry Run City, Nowhere", "A placeholder so you can see a suggestion appear."),
]


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    flags = {a for a in sys.argv[1:] if a.startswith("--")}
    if len(args) < 2:
        sys.exit(__doc__)
    base, admin = args[0].rstrip("/"), args[1]
    run = Runner(base, admin)

    run.check()
    if "--cleanup" in flags:
        run.cleanup()
        return

    ballots = run.admin("/results")["ballots"]
    real = [b for b in ballots if not b["voter"].startswith("Dry Run")]
    if real and "--force" not in flags:
        print(f"\n  STOP — {len(real)} real ballot(s) already exist: "
              f"{', '.join(b['voter'] for b in real[:5])}")
        print("  This looks like your live poll. Use a VOTE_POLL_ID=dryrun poll instead,")
        print("  or re-run with --force if you really mean it.")
        sys.exit(1)

    run.step1_nominate()
    run.step2_suggestions()
    run.step3_grace()
    run.step4_voting()
    run.step5_close()
    run.finish()


class Runner:
    def __init__(self, base, admin):
        self.base, self.admin_key = base, admin
        self.tokens = {}

    # ── plumbing ────────────────────────────────────────────────────────────
    def call(self, path, method="GET", body=None, token=None, admin=False):
        req = urllib.request.Request(self.base + "/vote/api" + path, method=method)
        if body is not None:
            req.add_header("Content-Type", "application/json")
            req.data = json.dumps(body).encode()
        if token:
            req.add_header("X-Ballot-Token", token)
        if admin:
            req.add_header("X-Admin-Key", self.admin_key)
        try:
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.status, json.loads(r.read().decode())
        except urllib.error.HTTPError as e:
            try:
                return e.code, json.loads(e.read().decode() or "{}")
            except Exception:
                return e.code, {}
        except urllib.error.URLError as e:
            sys.exit(f"\n  Could not reach {self.base} — {e.reason}")

    def admin(self, path, method="GET", body=None):
        s, d = self.call(path if path.startswith("/admin") else "/admin" + path,
                         method, body, admin=True)
        if s == 401:
            sys.exit("\n  Admin key rejected. Check the second argument.")
        if s >= 400:
            sys.exit(f"\n  {path} failed ({s}): {d.get('error')}")
        return d

    def settings(self, **kw):
        return self.admin("/settings", "POST", kw)

    @staticmethod
    def at(**delta):
        return (datetime.datetime.now(datetime.timezone.utc)
                + datetime.timedelta(**delta)).isoformat()

    def pause(self, *lines):
        print()
        for ln in lines:
            print("   " + ln)
        try:
            input("\n   [enter] to continue ")
        except (EOFError, KeyboardInterrupt):
            sys.exit("\n  Stopped. Run with --cleanup to undo.")

    def head(self, n, title):
        print(f"\n{'─' * 62}\n  STEP {n}: {title}\n{'─' * 62}")

    # ── steps ───────────────────────────────────────────────────────────────
    def check(self):
        s, p = self.call("/poll")
        if s == 503:
            sys.exit("\n  The server has no DATABASE_URL configured.")
        if s != 200:
            sys.exit(f"\n  /vote/api/poll returned {s}. Is the URL right?")
        if "phase" not in p:
            sys.exit("\n  This deployment is running older code — no 'phase' field.\n"
                     "  Redeploy from main, then re-run.")
        print(f"  Connected: {self.base}")
        print(f"  Poll \"{p.get('title')}\" — phase: {p['phase']}, "
              f"{p.get('destinationCount', len(p.get('destinations', [])))} destinations")

    def step1_nominate(self):
        self.head(1, "Suggestions only")
        self.settings(addsCloseAt=self.at(hours=2), opensAt=self.at(hours=3),
                      closesAt=self.at(days=2), allowAdds=True)
        s, p = self.call("/poll")
        assert p["phase"] == "nominate", p["phase"]
        print(f"  phase={p['phase']}  votingOpen={p['votingOpen']}  "
              f"destinations returned={len(p['destinations'])} (blind)")
        self.pause(
            f"Open {self.base}/vote/ and enter any name.",
            "",
            "You should see: Location + why fields, '2 of 2 left', a countdown to",
            "voting opening — and NO ranking, NO list of the six seeded places.",
        )

    def step2_suggestions(self):
        self.head(2, "Fake voters make suggestions")
        for name in FAKE:
            s, d = self.call("/claim", "POST", {"name": name})
            if s == 200:
                self.tokens[name] = d["token"]
        tok = next(iter(self.tokens.values()))
        for nm, blurb in FAKE_DESTS:
            s, d = self.call("/destinations", "POST", {"name": nm, "blurb": blurb}, token=tok)
            print(f"  added {nm!r} -> {s}" + (f" ({d.get('remaining')} left)" if s == 200 else ""))
        s, d = self.call("/destinations", "POST", {"name": "Second One, Nowhere"}, token=tok)
        s, d = self.call("/destinations", "POST", {"name": "Third One, Nowhere"}, token=tok)
        print(f"  third suggestion by the same voter -> {s} {d.get('code')}  (should be 403 ADD_LIMIT)")
        self.pause(
            "Add one of your own on the site — the counter should drop to '1 of 2 left'",
            "and your suggestion should appear under 'Your suggestions'.",
            "",
            "You should NOT see the fake voters' suggestions. Only your own.",
        )

    def step3_grace(self):
        self.head(3, "Grace window — suggestions shut, voting not open")
        self.settings(addsCloseAt=self.at(minutes=-1))
        s, p = self.call("/poll")
        print(f"  phase={p['phase']}  allowAdds={p['allowAdds']}  votingOpen={p['votingOpen']}")
        tok = next(iter(self.tokens.values()))
        s, d = self.call("/destinations", "POST", {"name": "Too Late, Nowhere"}, token=tok)
        print(f"  a late suggestion -> {s} {d.get('code')}  (should be 403 ADDS_LOCKED)")
        self.pause(
            "Reload the site. The suggestion form should be GONE, replaced by",
            "'Suggestions are closed … voting opens …'. Still no ranking.",
            "",
            f"This is also when you'd prune duplicates at {self.base}/vote/admin.html",
        )

    def step4_voting(self):
        self.head(4, "Voting opens")
        self.settings(opensAt=self.at(minutes=-1))
        s, p = self.call("/poll")
        print(f"  phase={p['phase']}  {len(p['destinations'])} destinations now visible")
        for name, ranks in FAKE.items():
            tok = self.tokens.get(name)
            if not tok:
                continue
            ids = [d["id"] for d in p["destinations"]]
            order = [r for r in ranks if r in ids] + [i for i in ids if i not in ranks]
            self.call("/ballot", "PUT", {"rankings": order, "submitted": True}, token=tok)
        print(f"  {len(self.tokens)} fake ballots submitted")
        self.pause(
            "Reload. You should now get the full ranked ballot with ▲▼ buttons.",
            "Put it in any order and hit Submit.",
            "",
            "The header should list who has voted so far.",
        )

    def step5_close(self):
        self.head(5, "Close and reveal")
        out = self.admin("/close", "POST", {"force": True})
        mail = out.get("mail", {})
        print(f"  closed. email sent: {mail.get('sent')}"
              + (f" ({mail.get('error') or mail.get('skipped')})" if not mail.get("sent") else ""))
        print(f"  subject: {out.get('subject')}")
        s, r = self.call("/results")
        if s == 200:
            print(f"  results public — winner: {r['winner']['name'] if r['winner'] else None}, "
                  f"{len(r['rounds'])} rounds")
            leaked = [n for n in list(FAKE) if n in json.dumps(r)]
            print(f"  privacy check: voter names in results payload -> "
                  f"{leaked if leaked else 'none (correct)'}")
        self.pause(
            "Reload the site one more time — you should land on the reveal.",
            "Click through the rounds and watch the eliminations and transfers.",
            "",
            "Also check your inbox for the results email.",
        )

    # ── teardown ────────────────────────────────────────────────────────────
    def cleanup(self):
        print("\n  Cleaning up dry-run data…")
        r = self.admin("/results")
        for b in r["ballots"]:
            if b["voter"].startswith("Dry Run"):
                self.admin("/reset-voter", "POST", {"name": b["voter"]})
                print(f"    removed ballot: {b['voter']}")
        for d in r["destinations"]:
            if "Nowhere" in d["name"] or d["name"].startswith("Dry Run"):
                self.call(f"/admin/destinations/{d['id']}", "DELETE", admin=True)
                print(f"    removed destination: {d['name']}")
        self.admin("/reopen", "POST", {})
        self.settings(opensAt=None, addsCloseAt=None, closesAt=None, allowAdds=True)
        print("\n  Poll reopened with the dates cleared.")
        print("  Set your real dates before sharing the link again.")

    def finish(self):
        print(f"\n{'─' * 62}\n  DONE — every phase worked end to end.\n{'─' * 62}")
        try:
            ans = input("\n  Remove the fake voters and reset the poll? [Y/n] ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            ans = "n"
        if ans in ("", "y", "yes"):
            self.cleanup()
        else:
            print("\n  Left as is. Run again with --cleanup when you're ready.")


if __name__ == "__main__":
    main()
