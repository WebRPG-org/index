# WebRPG Index

This repository hosts a JSON index of web-playable RPG Maker games found on GitHub.

Data file:

- `list.json`

The list is sorted by `title`. Language metadata is intentionally omitted until it can be verified reliably.

## Fork Workflow

The `Index GitHub RPG Maker repositories` workflow runs daily and searches GitHub code for RPG Maker MV/MZ web entry files. It adds repositories that are not already in `list.json`.

The `Fork listed repositories` workflow runs automatically after the index workflow succeeds. It reads `list.json`, deduplicates source repositories, and forks missing repositories into `WebRPG-org`.

Add a repository or organization secret named `WEBRPG_FORK_TOKEN` to create forks. The same token can be used for code search, or you can add a separate `WEBRPG_SEARCH_TOKEN`.

The token must belong to a user or app that can create repositories in `WebRPG-org`. For fine-grained tokens, GitHub documents the fork endpoint as requiring repository `Administration` write permission and `Contents` read permission.

The workflow waits between fork creation requests to avoid GitHub secondary rate limits. Defaults:

- `create_delay_seconds`: `20`
- `retry_limit`: `5`
- `retry_base_delay_seconds`: `60`

If GitHub still reports that requests were submitted too quickly, increase `CREATE_DELAY_SECONDS` in `.github/workflows/fork-listed-repos.yml`. Existing forks are detected and skipped.

The prepare workflow also treats WebRPG forks as disposable generated deployments:

- It reads the upstream repository's default-branch commit.
- When the upstream commit differs from the recorded `sourceHeadSha`, it force-resets the fork's default branch to the upstream commit, discarding previous generated changes.
- It then runs the normal validation, flattening, analytics injection, cover generation, and Pages setup again.
- The index records `sourceDefaultBranch`, `sourceHeadSha`, and `processedHeadSha` for processed forks.

Repositories are skipped when:

- The source repository is already forked into `WebRPG-org`.
- `WebRPG-org` already has a repository with the target fork name.
- The `list.json` entry is marked `invalid_structure`, `deleted_invalid_structure`, or `duplicate_name`.
- Another entry already uses the same repository name, even when the owner is different.

Fork names use this format:

```text
sourceOwner-sourceRepo
```

This avoids name collisions for common repository names such as `game`, `rpg`, and `github.io`.

## Prepare Fork Workflow

The `Prepare fork repositories` workflow runs automatically after the fork workflow succeeds. It processes fork repositories that already exist in `WebRPG-org`.

It flattens the project directory to the repository root so that Pages serves the game from the repository URL, keeping every file outside that directory where it is. Then it does two things for each matching fork:

- Adds this analytics script tag to HTML files that do not already contain it:

```html
<script defer src="https://insight.ravelloh.com/script.js?siteId=5ace6623-f51b-4571-8f60-e0473ea3317b"></script>
```

- Enables GitHub Pages from the repository default branch and `/`.

The public Pages URL path is determined by the repository name. For example, `WebRPG-org/example-game` is published at:

```text
https://webrpg.org/example-game/
```

This workflow uses a GitHub App token. Create and install a GitHub App on `WebRPG-org`, then add these Actions settings to this repository or to the organization with access granted to this repository:

- Variable: `WEBRPG_APP_CLIENT_ID`
- Secret: `WEBRPG_APP_PRIVATE_KEY`

Recommended GitHub App repository permissions:

- `Administration`: read and write
- `Contents`: read and write
- `Pages`: read and write
- `Metadata`: read-only

Install the App on all repositories in `WebRPG-org`. This matters because new fork repositories will be added over time; a selected-repositories installation will not automatically include new forks.

The workflow is fully automatic. It does not run in dry-run mode.

During each run, the workflow validates every matching fork before preparing Pages. A fork is treated as valid only when it has an RPG Maker MV/MZ web structure, such as a HTML entry file plus the expected `js/rpg_core.js` or `js/rmmz_core.js` runtime files.

When `dry_run=false` and `delete_invalid_repos=true`, invalid forks are deleted from `WebRPG-org` — unless the repository has no upstream, in which case it may be the only copy and is kept. The final aggregation job updates `list.json` with validation metadata:

- `status`
- `checkedAt`
- `forkName`
- `pagesUrl`
- `entryPath`
- `cover`
- `invalidReason`
- `deletedAt`
- `lastCheckError`
- `consecutiveFailures`
- `lastFailedAt`

Cover URLs are inferred from the fork's title screens: `img/titles1/*` first, then `img/titles2/*`. Nothing else is used — the application icon and favicons are the wrong shape and look broken as a full-size banner. Encrypted `.rpgmvp` covers are decrypted back to PNG before being committed.

### Entry status values

| `status` | Meaning |
| --- | --- |
| `indexed` | Discovered by the index workflow, not checked yet. |
| `verified` | The fork has a complete RPG Maker MV/MZ web structure and Pages is enabled. |
| `invalid_structure` | No usable project was found; the fork is deleted and never re-forked. |
| `skipped_large` | The upstream repository exceeds a size limit, so it is not prepared. |
| `duplicate_name` | Another entry already maps to this fork. |
| `hidden` | Manually hidden in `list.json`; its fork is removed on the next prepare run. |
| `check_error` | The last check could not reach a verdict; the entry is not advertised as playable. |
| `unavailable` | The check cannot succeed. Retired without further retries. |
| `retry_exhausted` | Every retry failed. Retired, but kept so it can be revived by hand. |

Every status other than `indexed`, `verified` and `check_error` is terminal. `scripts/repo-status.mjs` holds that list so the fork workflow and the prepare plan cannot drift apart, skip an entry in one and act on it in the other.

### Derived metadata

`pagesUrl`, `cover`, `coverPath`, `entryPath` and `projectRoot` only describe a fork that the most recent check verified. Every other outcome clears them, so an entry cannot advertise a page, cover or entry path that is no longer prepared. `verified` additionally clears `lastCheckError` and `consecutiveFailures`, so a transient failure leaves no stale error text behind once the fork recovers.

### Failure handling

`process-fork-repo.mjs` classifies every failure as `transient` or `permanent` and records it as `failureKind`:

- **transient** — server errors, network failures, rate limits, and lost ref races (`Update is not a fast forward`). These recover on their own.
- **permanent** — a `404`, a `403` that is not rate limiting (such as `Resource not accessible by integration`, which means the GitHub App is not installed on that repository), or a `422` the API rejects outright.

A failing check increments `consecutiveFailures` and records `lastFailedAt`, and the entry degrades in stages:

1. Under `FAILURE_THRESHOLD` (default `3`) failures, with a `pagesUrl` on record, the entry keeps its status and its link. A rate limit must not pull a working game off the site.
2. From `FAILURE_THRESHOLD` failures: `check_error`. Not advertised as playable, still retried.
3. `RETRY_LIMIT` (default `8`) consecutive failures: `retry_exhausted`. Retired.
4. Any `permanent` failure: `unavailable`, retired immediately.

The fork workflow can also fail before a check ever runs. It reports those failures to the prepare workflow, which retires an entry when its source repository cannot be forked at all: a name that no longer exists will not resolve on a later run, and until then every run retried it while the entry stayed `indexed` forever. Transient fork failures are left alone and retried as before.

### Deployment verification

Structural validation only proves the files are there, which is how entries could sit in the list as `verified` while serving a 404 or an unrelated page. Once a repository is prepared, `process-fork-repo.mjs` fetches the published entry point and requires it to contain an RPG Maker entry script. A deployment created or changed in the same run is skipped, because it has not propagated yet; the next run verifies it.

A missing page, or one that answers with something other than the game, fails the check and enters the usual ladder. Network errors and 5xx responses are recorded without failing: they say more about the network than about the deployment, and a site-wide outage must not retire every entry at once.

### Repositories without an upstream

Membership in the index is what makes a repository one of ours, not GitHub's fork flag. A fork loses that flag when its upstream is deleted, made private or transferred away, and those repositories are the ones still serving the game.

The prepare plan selects every repository named in `list.json`, and `process-fork-repo.mjs` validates a repository without an upstream in place instead of dropping it. There is nothing to synchronize from, and nothing to recover if it is deleted, so such a repository is never removed.

Retired entries are skipped by the fork and prepare workflows and have their derived metadata cleared, but the entry itself stays in `list.json`. That record is what stops the index workflow from discovering the same repository again, forking it a second time and repeating the same failure. Their forks are kept as well: when the upstream repository is gone, the fork may be the only remaining copy of the game.

Setting the status back to `indexed` returns an entry to the queue.

A fork is claimed by a single entry. When several entries map to the same fork — a monorepo exposing more than one project — the first one keeps the result and the others become `duplicate_name` with their derived metadata cleared.

### Queue order

`plan-fork-repos.mjs` orders forks by the `checkedAt` recorded in `list.json`, least recently checked first. Ordering by the repository's own `updated_at` stranded forks that fail validation: a failed run never bumps `updated_at`, so the same repositories were retried on every run while the rest of the queue never advanced.

Terminal entries are skipped by the fork workflow, so a fork that was deleted is never recreated on a later run. `hidden` is the exception: the prepare plan still visits it once so its fork can be removed.
