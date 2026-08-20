# CI/CD + ATN Publish — Design

**Date:** 2026-08-20
**Branch:** `feat-ci-cd-atn-publish`
**Status:** Design (spec) — awaiting user review before implementation planning

---

## 1. Goal

Automate the full path from a developer commit to a published HuNote release on **addons.thunderbird.net (ATN)**:

- Every PR / push runs lint + unit tests + e2e matrix (Thunderbird × IMAP backend) so regressions are caught in review.
- A single `git tag vX.Y.Z && git push --tags` triggers: build XPI with version derived from the tag → gate on all tests → upload to ATN → GitHub Release with auto-generated commit list.
- No manual steps between tag push and public release.
- No version-bump commits — version lives in the tag, not in git-tracked source.
- No real Gmail credentials in CI (dev-scripts/.env stays local).

## 2. Architecture

### Stack

- **CI platform:** GitHub Actions (already the repo host)
- **Node:** 20 LTS (via `.nvmrc`)
- **Build:** existing `Makefile` (`make pack` produces `dist/hunote.xpi`)
- **Lint:** `web-ext lint` (Mozilla official)
- **Unit tests:** `vitest` (already in place, 166 tests)
- **E2E tests:** existing `tests/e2e/` (pytest + Marionette + real Thunderbird)
- **E2E containerization:** Docker (TB + xvfb + Python bundled in one image; IMAP as sidecar)
- **IMAP backends for e2e:** Dovecot + GreenMail matrix (no real Gmail in CI)
- **ATN signing/upload:** `kewisch/action-web-ext@v2` with `apiUrlPrefix: https://addons.thunderbird.net/api/v4`
- **Release notes:** `gh release create --generate-notes` (auto commit list since previous tag)
- **Dependency updates:** GitHub Dependabot (weekly npm + gh-actions PRs)

### Branch + workflow layout

- **Feature branch:** `feat-ci-cd-atn-publish` → PR → merge to `main`.
- **Two workflows:**
  1. `.github/workflows/ci.yml` — triggers on PR and push to `main`. Runs lint + unit + e2e matrix + XPI build (artifact only, no publish).
  2. `.github/workflows/release.yml` — triggers on tag `v*`. Runs version-consistency gate + full CI gates (reuses ci.yml via `workflow_call`) + ATN upload + GitHub Release.

### Thunderbird version matrix

Test against ESR (LTS-equivalent, where most users are) + latest stable (catch regressions early):

| Slot          | Version       | Reason                                  |
|---------------|---------------|-----------------------------------------|
| Current ESR   | `140.14.0esr` | Our declared `strict_min_version`; LTS. |
| Next ESR      | `153.1.0esr`  | Upcoming LTS; users migrate here next.  |
| Latest stable | `154.0`       | Catch quick-release regressions early.  |

Matrix: `[140.14.0esr, 153.1.0esr, 154.0]` × `[dovecot, greenmail]` = **6 parallel e2e jobs**.

### Secrets (GitHub repository secrets)

- `ATN_SIGN_KEY` — JWT issuer (ATN API key)
- `ATN_SIGN_SECRET` — JWT signing secret

That is all. No Gmail creds, no other tokens.

## 3. File Structure

### New files

```
.github/
├── workflows/
│   ├── ci.yml                        # PR + push: lint + unit + e2e matrix + build XPI
│   └── release.yml                   # tag v*: gates + ATN upload + GH Release
└── dependabot.yml                    # weekly npm + gh-actions update PRs

docker/
├── e2e.Dockerfile                    # ARG TB_VERSION; base: TB + xvfb + python3 + pytest + Marionette client
├── docker-compose.dovecot.yml        # Dovecot IMAP sidecar + healthcheck
└── docker-compose.greenmail.yml      # GreenMail IMAP sidecar + healthcheck

tests/e2e/
└── docker_backends.md                # local dev docs: how to run e2e against Docker backends

CONTRIBUTING.md                       # release process, how to tag + what happens automatically
.nvmrc                                # "20"
```

### Modified files

| File                  | Change                                                                                     |
|-----------------------|--------------------------------------------------------------------------------------------|
| `Makefile`            | Rewrite `pack` to derive VERSION (env override or `date +%Y%m%d%H%M%S`), stage `src/` into `build/`, patch `build/manifest.json` via `jq`, zip from `build/`. Add targets: `lint`, `e2e-dovecot`, `e2e-greenmail`, `ci-local`. |
| `src/manifest.json`   | Set `"version": "0.0.0"` as permanent placeholder (never bumped in git).                   |
| `package.json`        | Add devDep: `web-ext@10.6.0`. Add scripts: `lint`, `pack`. **Delete `version` field entirely.** |
| `tests/e2e/conftest.py` | Parametrize IMAP host/port/user/password from env vars (defaults keep local dev working). |
| `.gitignore`          | Ensure `dist/`, `build/`, `.web-ext-artifacts/` ignored.                                   |

### Explicitly excluded (YAGNI)

- Custom `atn-upload.mjs` script — replaced by `kewisch/action-web-ext@v2`.
- `scripts/bump-version.sh` — version comes from git tag at build time, no bump commit.
- `scripts/verify-tag.sh` — single source (tag), nothing to cross-check.
- `changesets` / `semantic-release` — auto notes via `gh release --generate-notes`.
- Explicit `CHANGELOG.md` file — same reason.
- Nightly builds, beta channel, Slack/email notifications — not requested.

## 4. Component Responsibilities

### `Makefile` — `pack` target (rewritten)

Pseudo-code:

```makefile
VERSION ?= $(shell date +%Y%m%d%H%M%S)
XPI := dist/hunote-$(VERSION).xpi

pack:
	rm -rf build dist/hunote-$(VERSION).xpi
	mkdir -p build dist
	cp -r src/. build/
	jq --arg v "$(VERSION)" '.version = ($$v | if test("^[0-9]+\\.[0-9]+\\.[0-9]+") then . else "0.0.0." + . end)' \
	    src/manifest.json > build/manifest.json
	cd build && zip -qr ../$(XPI) . -x '*.DS_Store'
	@echo "Built $(XPI) (version $$(jq -r .version build/manifest.json))"
```

Behavior:
- **Release build** (CI on tag): `VERSION=0.2.0 make pack` → `dist/hunote-0.2.0.xpi` with `manifest.version = "0.2.0"`.
- **Local dev build**: `make pack` → `dist/hunote-20260820153042.xpi` with `manifest.version = "0.0.0.20260820153042"` (TB-valid 4-segment version, monotonic).
- `src/manifest.json` in git stays at `"version": "0.0.0"` forever — never modified by any script.

### `.github/workflows/ci.yml`

Trigger: `pull_request` on any branch + `push` on `main` + `workflow_call` (reused from release.yml).

Inputs (when called via workflow_call): `version` (string) — the version to stamp into the XPI.

Jobs:

1. **lint** — Ubuntu, Node 20, `npm ci`, `npx web-ext lint --source-dir=src`. Uses `src/` directly (manifest has `0.0.0`, valid semver — lint passes).
2. **unit** — Ubuntu, Node 20, `npm ci`, `npm test`.
3. **e2e** — Ubuntu, matrix `{tb: [140.14.0esr, 153.1.0esr, 154.0], imap: [dovecot, greenmail]}`. Builds `docker/e2e.Dockerfile` with `--build-arg TB_VERSION=${{ matrix.tb }}`, runs the matching `docker-compose.*.yml` sidecar, executes `pytest tests/e2e/` inside the TB container.
4. **build** — Ubuntu, `VERSION=${{ inputs.version || format('{0}', github.sha) }} make pack` → uploads `dist/hunote-*.xpi` as workflow artifact.

Dependencies: `build` needs `lint + unit + e2e` pass.

### `.github/workflows/release.yml`

Trigger: `push` on tag `v*`.

Steps:

1. Extract version: `VERSION=${GITHUB_REF_NAME#v}` (e.g. `v0.2.0` → `0.2.0`).
2. **ci** — `uses: ./.github/workflows/ci.yml` with `version: ${{ env.VERSION }}` (all gates must pass on the tagged commit; XPI is built with the tag version).
3. **publish** — needs `ci`. Downloads `dist/hunote-${VERSION}.xpi` artifact from ci run. Calls `kewisch/action-web-ext@v2` with `cmd: sign`, `channel: listed`, `apiUrlPrefix: https://addons.thunderbird.net/api/v4`, `apiKey: ${{ secrets.ATN_SIGN_KEY }}`, `apiSecret: ${{ secrets.ATN_SIGN_SECRET }}`. Then `gh release create ${{ github.ref_name }} dist/hunote-${VERSION}.xpi --generate-notes`.

### `.github/dependabot.yml`

Two ecosystems:

- `npm` (root `package.json`) — weekly PRs, grouped patch+minor.
- `github-actions` (`.github/workflows/`) — weekly PRs, pins action SHAs updated.

### `docker/e2e.Dockerfile`

Base image: `ubuntu:24.04`. Installs:
- `xvfb`, `x11-utils`, `dbus-x11`
- `python3`, `python3-pip`, `pytest`, marionette client deps
- Thunderbird via `curl` from `https://ftp.mozilla.org/pub/thunderbird/releases/${TB_VERSION}/linux-x86_64/en-US/thunderbird-${TB_VERSION}.tar.xz` (ARG `TB_VERSION`)
- Working dir `/hunote`, entry point `xvfb-run pytest tests/e2e/`

### `docker/docker-compose.dovecot.yml`

Services:
- `imap`: image `dovecot/dovecot:latest`, port `1143`, healthcheck via `nc -z localhost 143`, seeded with test user `hunote@test / hunote`.
- `tb`: build from `docker/e2e.Dockerfile`, `depends_on: {imap: {condition: service_healthy}}`, env `IMAP_HOST=imap IMAP_PORT=143 IMAP_USER=hunote@test IMAP_PASSWORD=hunote`.

### `docker/docker-compose.greenmail.yml`

Same shape as dovecot compose, but service `imap` uses `greenmail/standalone:2.1.0` and the corresponding user/password from GreenMail defaults.

### `tests/e2e/conftest.py` — modification

Add fixtures reading `IMAP_HOST`, `IMAP_PORT`, `IMAP_USER`, `IMAP_PASSWORD` from env; fall back to current hardcoded local dev values so no local behavior changes.

### `CONTRIBUTING.md` — new

Sections:
- Local dev setup (nvm, npm ci, make pack)
- Running tests: unit (`npm test`), e2e local (`make e2e-dovecot`, `make e2e-greenmail`)
- Local build: `make pack` → `dist/hunote-YYYYMMDDhhmmss.xpi` (dev version derived from timestamp)
- Release process:
  1. `git tag vX.Y.Z`
  2. `git push && git push --tags`
  3. Watch Actions → release workflow → verify ATN listing appears
- Note: version is never stored in git; `src/manifest.json` always contains `"version": "0.0.0"`. The real version is stamped into a copy at build time (`build/manifest.json`).

## 5. Data Flow

### Flow A — PR opened / commit pushed

```
Developer opens PR
   ↓
GitHub Actions: ci.yml triggers
   ↓
┌─────────┬─────────┬─────────┐
│  lint   │  unit   │  e2e    │  (parallel)
│web-ext  │ vitest  │ 6-way   │
│  lint   │ 166 t.  │ matrix  │
└─────────┴─────────┴─────────┘
   ↓ all green
build → dist/hunote.xpi as artifact
   ↓
PR shows green check → merge allowed
```

### Flow B — Release (tag push)

```
Developer: git tag v0.2.0 && git push --tags
   ↓
GitHub Actions: release.yml triggers on tag v*
   ↓
Extract VERSION=0.2.0 from ${GITHUB_REF_NAME#v}
   ↓
ci (workflow_call, version=0.2.0):
   ├── lint + unit + e2e matrix (same as flow A)
   └── build: VERSION=0.2.0 make pack → dist/hunote-0.2.0.xpi
   ↓ all green
publish:
   ├── kewisch/action-web-ext@v2 sign dist/hunote-0.2.0.xpi → ATN accepts
   └── gh release create v0.2.0 dist/hunote-0.2.0.xpi --generate-notes
         ↑ auto commit list since previous tag
   ↓
Public: extension live on addons.thunderbird.net; GitHub Release visible
```

### Flow C — Dependabot PR

```
Weekly: Dependabot opens PR (npm patch/minor OR gh-actions bump)
   ↓
ci.yml runs full suite (lint + unit + e2e matrix)
   ↓ all green
Developer reviews → merge → no release triggered (no tag)
```

## 6. Error Handling

- **Malformed tag** (e.g. `v0.2` instead of `v0.2.0`) → `make pack` step fails when ATN rejects non-3-segment version, or `web-ext lint` catches it earlier. Developer deletes bad tag, retags correctly.
- **web-ext lint errors** → PR blocked. Fix source, push again.
- **e2e flake on 1 matrix cell** → job marked failed; developer investigates. No auto-retry (would mask real flake).
- **ATN upload failure** → `kewisch/action-web-ext@v2` propagates non-zero exit; workflow fails. GitHub Release NOT created (order: sign first, then release). Developer investigates ATN status, may need to re-run publish job manually.
- **Duplicate version at ATN** → ATN rejects; error surfaces in Actions log. Developer deletes tag, retags with next version.
- **Docker image pull failure** → step fails; developer investigates (usually transient Docker Hub).

## 7. Testing Strategy

- **Unit tests:** unchanged, still `npm test` (vitest, jsdom).
- **E2E tests:** existing suite; new coverage is the **matrix dimension** (6 combos instead of 1 local run). Same test files, parametrized IMAP target.
- **CI-workflow tests:** manual — first PR after implementation validates the pipeline; first `v0.1.1` tag validates release.yml end-to-end.
- **Build reproducibility:** verify `VERSION=1.2.3 make pack` produces XPI whose `manifest.json` has exactly `"version": "1.2.3"` (add a make target `verify-pack` for the smoke check).

## 8. Rollback

- **Bad release published to ATN:** ATN admin panel supports disabling a version. Then bump next patch with fix.
- **Bad workflow change:** revert commit on `main` — Actions immediately pick up new workflow definition.
- **Bad Docker image tag:** update `docker/e2e.Dockerfile` ARG default; matrix will use the new value on next run.

## 9. Non-Goals (v1)

- Beta / unlisted channel — everything goes `channel: listed`.
- Nightly builds — no cron trigger.
- Signing for self-distribution outside ATN.
- Multi-repo / monorepo tooling.
- Custom notification hooks (Slack / email).
- CHANGELOG.md hand-curated file — GitHub Release notes are the single source.

## 10. Open Questions (defer until implementation)

- Exact Dovecot config for a clean IMAP + `x-hu-note` header roundtrip in Docker — verify during Task N.
- GreenMail port / TLS toggles — verify during Task N.
- `web-ext lint` currently unknown warnings — will surface during first CI run; fix inline as part of implementation.
