---
name: sync-upstream
description: Use when the user asks to update, sync or bring upstream changes into the fork — "atualizar a isolated", "sincronizar com a dev", "atualizar o fork", "trazer novidades do projeto original". Syncs the fork's `dev` with the original project, then merges `dev` into `isolated` without losing the fork's own changes.
---

# Sync upstream into `isolated`

Branch model of this fork (`origin` = `BrunoMoraes-Z/mycode`, `upstream` = `https://github.com/anomalyco/opencode.git`, default branch `dev`):

- `dev` — mirror of the original project's default branch. Never commit fork work here.
- `isolated` — the fork's own work, built on top of `dev`. Its changes must always be preserved.

Goal: bring `dev` up to date with the original project, then integrate it into `isolated`.

## Rules

- **Merge, never rebase** `isolated`. It is a published branch; merging keeps every fork commit intact and makes the update easy to undo.
- Never `push --force`, `reset --hard` or delete branches without the user's explicit confirmation.
- Never resolve a conflict by blindly taking `--theirs` on files the fork changed. The fork's intent must survive; adapt it to the new upstream code.
- If anything is unclear in a conflict, stop and ask the user.

## Steps

### 1. Preflight

```sh
git status --porcelain
git branch --show-current
```

If the working tree is dirty, ask the user whether to commit or stash (`git stash push -u -m "sync-upstream"`) before continuing. Remember to `git stash pop` at the end.

### 2. Update the fork's `dev` from the original project

Try, in order, and stop at the first that works:

1. **GitHub CLI (preferred)** — syncs the fork on GitHub with its parent:
   ```sh
   gh repo sync BrunoMoraes-Z/mycode --branch dev
   ```
   Fails if `gh` is missing/unauthenticated or if `dev` has diverged from upstream (it should never diverge — if it did, report it and stop).
2. **`upstream` remote** — if one exists (`git remote -v`), or the user tells you the original repo URL:
   ```sh
   git remote add upstream <url>   # only if missing
   git fetch upstream
   git push origin upstream/<default-branch>:dev   # fast-forward only; never force
   ```
   Discover the parent with `gh repo view BrunoMoraes-Z/mycode --json parent` when `gh` is available.
3. **Neither works** — tell the user to click "Sync fork" on GitHub for `dev`, wait for confirmation, then continue.

Then refresh locally:

```sh
git fetch origin
git switch dev
git merge --ff-only origin/dev
```

If `--ff-only` fails, local `dev` has extra commits: report them (`git log origin/dev..dev --oneline`) and ask before doing anything.

Upstream workflows must not run on the fork. `dev` stays identical to upstream, so they are disabled on GitHub instead of edited; disable any new one the sync brought in and cancel runs it started (only `isolated-release` stays active):

```powershell
$r = "BrunoMoraes-Z/mycode"
gh workflow list --all -R $r -L 100 --json path,state | ConvertFrom-Json |
  ? { $_.path -ne ".github/workflows/isolated-release.yml" -and $_.state -eq "active" } |
  % { gh workflow disable $_.path -R $r }
gh run list -R $r -b dev -L 50 --json databaseId,status | ConvertFrom-Json |
  ? { $_.status -ne "completed" } | % { gh run cancel $_.databaseId -R $r }
```

### 3. Preview what is coming

```sh
git switch isolated
git merge --ff-only origin/isolated   # make sure local isolated is current
git log --oneline isolated..dev | head -50
git rev-list --count isolated..dev
git diff --stat isolated...dev | tail -5
```

If `isolated..dev` is empty, `isolated` is already up to date — stop and report.

Record a safety point before merging:

```sh
git branch -f isolated-backup isolated
```

### 4. Merge

```sh
git merge --no-ff dev -m "chore: merge dev into isolated"
```

### 5. Resolve conflicts (if any)

```sh
git diff --name-only --diff-filter=U
```

For each conflicted file:

1. See what the fork changed: `git log --oneline dev..isolated-backup -- <file>` and `git diff dev...isolated-backup -- <file>`.
2. See what upstream changed: `git diff isolated-backup...dev -- <file>`.
3. Produce a result that keeps the fork's behavior on top of upstream's new code (renames, moved APIs, new parameters, etc.).
4. Lockfiles (`bun.lock`): take upstream's (`git checkout --theirs bun.lock`), then run `bun install` to re-add the fork's dependencies, and `git add bun.lock`.
5. Generated client files: do not hand-merge; take upstream's version and regenerate with `bun run generate` from `packages/client` after the merge.

Then `git add <file>` and, when all are resolved, `git commit --no-edit`.

To abort at any point: `git merge --abort` (or `git reset --hard isolated-backup` after confirming with the user).

### 6. Verify

```sh
bun install
bun run check
```

Run the tests of packages touched by the fork's changes (from the package directory, never the repo root; see the `unit-tests` skill). Fix breakages caused by upstream API changes in follow-up commits on `isolated`.

Confirm no fork change was lost — this should list only the fork's own commits/files:

```sh
git log --oneline --no-merges dev..isolated
git diff --stat dev isolated
```

Compare against `git diff --stat dev...isolated-backup`; every file the fork touched should still differ from `dev`.

### 7. Publish

Ask the user before pushing, then:

```sh
git push origin isolated
```

Delete the backup only when the user is satisfied: `git branch -D isolated-backup`.

## Report

Summarize: how `dev` was synced (gh / upstream / manual), number of upstream commits merged, conflicts and how each was resolved, check/test results, and whether it was pushed.
