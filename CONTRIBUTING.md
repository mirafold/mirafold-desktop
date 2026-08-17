# Contributing to Mirafold Desktop

Thanks for wanting to help. Three things to know before your first PR.

## Sign your commits (DCO)

This project uses the [Developer Certificate of Origin](https://developercertificate.org/)
(DCO) rather than a CLA: a one-line statement, per commit, that you have the
right to contribute the code under the project's MIT license. Add it with

```
git commit -s
```

which appends `Signed-off-by: Your Name <you@example.com>` to the commit
message. PRs with unsigned commits can't be merged. To have git add it for
you every time in this checkout, install this hook once:

```
cat > .git/hooks/prepare-commit-msg <<'HOOK'
#!/bin/sh
# Append Signed-off-by (DCO) from the configured git identity, idempotently.
NAME=$(git config user.name)
EMAIL=$(git config user.email)
[ -n "$NAME" ] && [ -n "$EMAIL" ] || exit 0
git interpret-trailers --in-place --if-exists doNothing \
  --trailer "Signed-off-by: $NAME <$EMAIL>" "$1"
HOOK
chmod +x .git/hooks/prepare-commit-msg
```

## Branch from `next`, not `main`

`main` is the production mirror and only moves at release time. Cut your
branch from `next` and open the PR into `next`. The whole flow — branches,
versions, tags, both release paths — is in [docs/RELEASING.md](docs/RELEASING.md).

## Before you open a PR

- Node 22, npm (`packageManager` in `package.json` names the exact npm).
  `npm test` must pass — it runs on Linux and Windows in CI, and both are
  required checks, so write tests that pass on both (a Windows checkout has
  CRLF line endings; `fileURLToPath` returns backslashes there).
- Read `CLAUDE.md` first: this repository contains no product. There is no
  UI, server, adapter, or protocol here — all of that is the published
  `mirafold` package, consumed unmodified. If a change starts to look like
  product behavior, it belongs upstream.
- The hard constraints in `CLAUDE.md` bind every change: the daemon stays a
  child process; no preload, IPC, or `nodeIntegration`; no `electron-rebuild`;
  Windows packages are built on Windows.
- Comments only for non-obvious constraints — the code says what it does.
- A new dependency must earn its place (`CLAUDE.md` → *Dependencies*).

Security issues: don't open a public issue — see [SECURITY.md](SECURITY.md).
