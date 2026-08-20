# Contributing to HuNote

## Local dev setup

```bash
nvm use              # picks up Node 20 from .nvmrc
npm ci
```

## Running tests

- **Unit:** `npm test` (vitest, jsdom, ~166 tests).
- **E2E local (podman/docker, Dovecot Gmail-mimicry):** `./tests/e2e/run-persistence-dovecot.sh`
- **E2E local (GreenMail):** `./tests/e2e/run.sh`
- **E2E matrix as CI runs it:** see `tests/e2e/docker_backends.md`
- **E2E against real Gmail (manual, requires `dev-scripts/.env`):** `./tests/e2e/run-persistence-gmail-real.sh`

## Local build

```bash
make pack
# → dist/hunote-YYYYMMDDhhmmss.xpi
# manifest.version becomes 0.0.0.YYYYMMDDhhmmss (TB-valid, monotonic)
```

To simulate a release-shape build locally:

```bash
VERSION=1.2.3 make pack && make verify-pack VERSION=1.2.3
# → dist/hunote-1.2.3.xpi with manifest.version="1.2.3"
```

## Linting

No `make lint` target: `web-ext lint` is the Firefox validator and always errors on Thunderbird `experiment_apis`. No Thunderbird-aware linter exists (checked 2026-08-20). ATN validates on upload.

## Release process

Version is derived from the git tag — nothing to bump in source.

```bash
git checkout main && git pull
git tag v0.2.0
git push && git push --tags
```

GitHub Actions will then:

1. Reject the tag if it is not semver `X.Y.Z`.
2. Run the full CI matrix on the tagged commit (unit + 6-way e2e).
3. Build `dist/hunote-0.2.0.xpi` (manifest patched from `"0.0.0"` to `"0.2.0"`).
4. Sign + submit to [addons.thunderbird.net](https://addons.thunderbird.net) via `kewisch/action-web-ext@v2`.
5. Create a GitHub Release with auto-generated commit list since the previous tag.

### Required repository secrets

Provision once (Settings → Secrets and variables → Actions):

- `ATN_SIGN_KEY` — ATN JWT issuer
- `ATN_SIGN_SECRET` — ATN JWT signing secret

Both are obtained from your ATN developer profile ([addons.thunderbird.net → Developer Hub → Manage API Keys](https://addons.thunderbird.net/developers/addon/api/key/)).

### If a release fails

- **Tag rejected as non-semver:** `git tag -d vX && git push --delete origin vX`, retag.
- **CI matrix red:** fix on `main`, delete the tag, retag from the new HEAD.
- **ATN upload failed:** re-run the failed job from the Actions UI; if the failure is at ATN itself (duplicate version, quota), bump the version and retag.

## Version rule

`src/manifest.json` always has `"version": "0.0.0"`. `package.json` has no `version` field. The real version exists only as a git tag and is stamped into `build/manifest.json` at build time. Do **not** hand-edit these version fields.
