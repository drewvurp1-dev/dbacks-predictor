#!/usr/bin/env python3
"""Set a deployed vote's title, subtitle and the three dates, interactively.

    python3 scripts/vote-config.py https://your-app.up.railway.app YOUR_ADMIN_KEY

Everything is typed at a prompt rather than passed as arguments, so no shell
quoting is involved — the reason this exists is that a curl one-liner carrying
JSON is easy to mangle on the way through a copy-paste, and the failure looks
like an unrelated shell error.

Times are entered as plain local wall-clock (YYYY-MM-DD HH:MM) and converted to
UTC using this machine's own timezone, which is the same thing the admin page's
date pickers do. Press enter at any prompt to leave that setting alone.
"""

import json
import sys
import urllib.request
import urllib.error
import datetime


def main():
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    base, key = sys.argv[1].rstrip("/"), sys.argv[2]

    tz = datetime.datetime.now().astimezone().tzinfo
    print(f"\n  {base}")
    print(f"  Times will be read in your local timezone: {tz}\n")

    poll = get(base, "/poll")
    if "phase" not in poll:
        sys.exit("  This deployment is running older code — redeploy from main first.")
    show(poll, tz)

    body = {}
    t = ask("Title", poll.get("title"))
    if t is not None:
        body["title"] = t
    s = ask("Subtitle (trip dates etc)", poll.get("subtitle"))
    if s is not None:
        body["subtitle"] = s

    print("\n  Dates — format 2026-08-15 23:59, or '-' to clear one.")
    for label, field, cur in [
        ("Suggestions close", "addsCloseAt", poll.get("addsCloseAt")),
        ("Voting opens",      "opensAt",     poll.get("opensAt")),
        ("Voting closes",     "closesAt",    poll.get("closesAt")),
        ("Reveal results (blank = same as voting closes)", "revealAt", poll.get("revealAt")),
    ]:
        v = ask_date(label, cur, tz)
        if v is not False:
            body[field] = v

    if not body:
        sys.exit("\n  Nothing changed.")

    print("\n  Sending:")
    for k, v in body.items():
        print(f"    {k}: {v}")
    if input("\n  Save? [Y/n] ").strip().lower() not in ("", "y", "yes"):
        sys.exit("  Cancelled.")

    st, out = call(base, "/admin/settings", "POST", body, key)
    if st == 401:
        sys.exit("\n  Admin key rejected.")
    if st >= 400:
        sys.exit(f"\n  Failed ({st}): {out.get('error')}")

    print("\n  Saved.\n")
    show(get(base, "/poll"), tz)


# ── helpers ─────────────────────────────────────────────────────────────────

def call(base, path, method="GET", body=None, key=None):
    req = urllib.request.Request(base + "/vote/api" + path, method=method)
    if body is not None:
        req.add_header("Content-Type", "application/json")
        req.data = json.dumps(body).encode()
    if key:
        req.add_header("X-Admin-Key", key)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except Exception:
            return e.code, {}
    except urllib.error.URLError as e:
        sys.exit(f"  Could not reach {base} — {e.reason}")


def get(base, path):
    st, d = call(base, path)
    if st != 200:
        sys.exit(f"  {path} returned {st}")
    return d


def local(iso, tz):
    if not iso:
        return "not set"
    return (datetime.datetime.fromisoformat(iso.replace("Z", "+00:00"))
            .astimezone(tz).strftime("%a %d %b %Y, %-I:%M %p"))


def show(p, tz):
    print(f"  Poll: {p.get('title')}")
    print(f"    phase              {p.get('phase')}")
    print(f"    suggestions close  {local(p.get('addsCloseAt'), tz)}")
    print(f"    voting opens       {local(p.get('opensAt'), tz)}")
    print(f"    voting closes      {local(p.get('closesAt'), tz)}")
    print(f"    reveal results     {local(p.get('revealAt'), tz)}")


def ask(label, current):
    cur = current or "(none)"
    v = input(f"  {label} [{cur}]: ").strip()
    return v if v else None


def ask_date(label, current, tz):
    """Returns an ISO string, None to clear, or False to leave unchanged."""
    while True:
        v = input(f"  {label} [{local(current, tz)}]: ").strip()
        if not v:
            return False
        if v == "-":
            return None
        try:
            naive = datetime.datetime.strptime(v, "%Y-%m-%d %H:%M")
        except ValueError:
            print("    Use 2026-08-15 23:59 — or '-' to clear, enter to skip.")
            continue
        return naive.replace(tzinfo=tz).astimezone(datetime.timezone.utc).isoformat()


if __name__ == "__main__":
    main()
