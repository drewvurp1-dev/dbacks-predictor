---
name: prsm
description: PRSM = create a Pull Request and Squash-Merge it to main. Use when the user says "prsm", "ship it", "PR and merge", or after pushing a finished change on a claude/* branch. Handles the cache-bust check, push, PR creation, squash-merge, and the rebase-on-conflict recovery path.
---

# PRSM — Pull Request + Squash-Merge

Encodes Snake Savant's ship procedure (see CLAUDE.md "Git Workflow"). Goal:
get the current feature branch's work onto `main` as a single squashed commit,
reliably, including the conflict-recovery path.

All GitHub operations use the **GitHub MCP tools** (`mcp__github__*`) — there is
no `gh` CLI in this environment. The repo is `drewvurp1-dev/dbacks-predictor`.

## Preconditions

1. Confirm you are on a `claude/*` feature branch, not `main`:
   `git branch --show-current`. Never PRSM from `main`.
2. Make sure the work is committed.

## Steps

### 1. Cache-bust guard (frontend safety)
If the branch touched any shipped frontend file, the `?v=N` entry tag must be
bumped first. Run the cache-bust check:

```bash
bash .claude/skills/cache-bust/bump.sh --check
```

If it reports MISSING, run `bash .claude/skills/cache-bust/bump.sh`, then commit
the `index.html` change (amend into the relevant commit or a `chore: cache-bust`
commit). If the `cache-bust` skill is available, prefer invoking it.

### 2. Validate
Run the test suite so a red build doesn't reach `main`:

```bash
npm run test:all
```

If it fails, stop and report — do not merge a failing branch unless the user
explicitly says to.

### 3. Push
```bash
git push -u origin "$(git branch --show-current)"
```
On network failure, retry up to 4× with exponential backoff (2s, 4s, 8s, 16s).

### 4. Create the PR
Use `mcp__github__create_pull_request` with `base: main`, `head:` the current
branch. Title = a concise summary of the change; body = what changed and why
(brief). Do **not** put any model identifier in the title or body.

### 5. Squash-merge
Use `mcp__github__merge_pull_request` with `merge_method: "squash"`.

### 6. Conflict-recovery path
If the merge fails because the branch is behind / conflicts with `main`:

```bash
git fetch origin main
git rebase origin/main
# resolve conflicts if any, then:
git push --force-with-lease
```

Then retry `mcp__github__merge_pull_request` (squash). You can also rebase
**proactively** in step 3 if you know the branch has fallen behind `main`.

## Notes

- One squashed commit per PR — always `merge_method: "squash"`.
- Only push to the designated `claude/*` branch and `main` via the merge.
  Never push directly to `main` or to another branch.
- Report the merged PR number/URL when done.
