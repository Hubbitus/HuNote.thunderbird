# CI/CD + ATN Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship every HuNote release to addons.thunderbird.net (ATN) automatically from a `git tag vX.Y.Z && git push --tags`, with every PR gated by lint + unit + 6-way e2e matrix.

**Architecture:** GitHub Actions with two workflows (`ci.yml`, `release.yml`), tag-driven versioning (no bump commits — version stamped into a copy of `manifest.json` inside `build/`), Docker-based e2e reusing the existing `tests/e2e/` suite against a Dovecot/GreenMail matrix, XPI signing/upload via `kewisch/action-web-ext@v2`, GitHub Release notes via `gh release --generate-notes`, dependency updates via Dependabot.

**Tech Stack:** GitHub Actions, Node 20 LTS, Make, jq, Docker (podman-compatible compose), Thunderbird ESR/stable matrix `[140.14.0esr, 153.1.0esr, 154.0]`, Dovecot + GreenMail sidecars, pytest + Marionette (existing), `kewisch/action-web-ext@v2`, `web-ext@10.6.0`, GitHub CLI.

---

## Spec reference

Design: `docs/superpowers/specs/2026-08-20-cicd-atn-publish-design.md`.

## Prereqs

- Branch `feat-ci-cd-atn-publish` is checked out.
- `dev-scripts/.env` (Gmail creds) is gitignored and stays local.
- Docker or podman available locally for smoke testing new compose files.
- GitHub repo secrets `ATN_SIGN_KEY` and `ATN_SIGN_SECRET` will be provisioned by the maintainer before the first tag push (out of scope for this plan; document in CONTRIBUTING.md).

---

## Task 1: Freeze `src/manifest.json` at `"version": "0.0.0"` + delete `package.json` version

**Files:**
- Modify: `src/manifest.json:4`
- Modify: `package.json:3`

- [ ] **Step 1: Edit manifest to placeholder version**

Change `src/manifest.json` line with `"version": "0.1.0"` to:

```json
  "version": "0.0.0",
```

- [ ] **Step 2: Delete `version` field from package.json**

Remove the `"version": "0.1.0",` line entirely from `package.json`.

Resulting `package.json`:

```json
{
  "name": "hunote",
  "private": true,
  "type": "module",
  "description": "Thunderbird extension: server-stored notes via IMAP headers",
  "scripts": {
    "test": "vitest run --passWithNoTests",
    "test:watch": "vitest",
    "coverage": "vitest run --coverage"
  },
  "devDependencies": {
    "@vitest/coverage-v8": "^2.1.0",
    "jsdom": "^30.0.1",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 3: Sanity-check unit tests still pass**

Run: `npm test`
Expected: all vitest tests green (166 pass).

- [ ] **Step 4: Commit**

```bash
git add src/manifest.json package.json
git commit -m "chore(version): freeze manifest to 0.0.0, remove package.json version

Version is now derived from git tag at build time; both files no longer
carry a persisted version number."
```

---

## Task 2: Rewrite `Makefile` `pack` target for tag-driven versioning

**Files:**
- Modify: `Makefile:1-45`

- [ ] **Step 1: Update `.PHONY` and add version variables**

Replace the top of `Makefile` (lines 1-6):

```makefile
.PHONY: help test test-e2e test-e2e-gui coverage pack verify-pack lint run run-fresh clean

SRC_DIR   := src
BUILD_DIR := build
DIST_DIR  := dist
VERSION   ?= $(shell date +%Y%m%d%H%M%S)
# semver X.Y.Z passes through unchanged; timestamps become 0.0.0.<ts> (TB-valid 4-segment).
XPI       := $(DIST_DIR)/hunote-$(VERSION).xpi
```

- [ ] **Step 2: Rewrite `pack` target**

Replace the existing `pack:` block (lines 32-35) with:

```makefile
pack:
	@rm -rf $(BUILD_DIR) $(XPI)
	@mkdir -p $(BUILD_DIR) $(DIST_DIR)
	@cp -r $(SRC_DIR)/. $(BUILD_DIR)/
	@jq --arg v "$(VERSION)" \
	    '.version = (if ($$v | test("^[0-9]+\\.[0-9]+\\.[0-9]+$$")) then $$v else "0.0.0." + $$v end)' \
	    $(SRC_DIR)/manifest.json > $(BUILD_DIR)/manifest.json
	@cd $(BUILD_DIR) && zip -qr ../$(XPI) . -x '*.DS_Store'
	@echo "Built $(XPI) (manifest.version=$$(jq -r .version $(BUILD_DIR)/manifest.json), size=$$(du -h $(XPI) | cut -f1))"
```

- [ ] **Step 3: Add `verify-pack` target**

Append to `Makefile`:

```makefile
verify-pack:
	@test -f $(XPI) || (echo "no XPI at $(XPI); run 'make pack' first" && exit 1)
	@ACTUAL=$$(unzip -p $(XPI) manifest.json | jq -r .version); \
	 EXPECTED=$$(jq -r --arg v "$(VERSION)" \
	    '(if ($$v | test("^[0-9]+\\.[0-9]+\\.[0-9]+$$")) then $$v else "0.0.0." + $$v end)' \
	    <<<'{}'); \
	 test "$$ACTUAL" = "$$EXPECTED" || (echo "mismatch: manifest=$$ACTUAL expected=$$EXPECTED" && exit 1); \
	 echo "verify-pack ok ($$ACTUAL)"
```

- [ ] **Step 4: Add `lint` target**

Append to `Makefile`:

```makefile
lint:
	@npx web-ext lint --source-dir=$(SRC_DIR) --pretty
```

- [ ] **Step 5: Update `clean` to also remove `build/`**

Replace the existing `clean:` block with:

```makefile
clean:
	rm -rf $(BUILD_DIR) $(DIST_DIR) coverage
```

- [ ] **Step 6: Update `_setup.sh` reference to XPI path**

In `tests/e2e/_setup.sh` inside `e2e_build_xpi()`, replace:

```bash
	XPI_ABS="$(readlink -f dist/hunote.xpi)"
```

with:

```bash
	XPI_ABS="$(readlink -f dist/hunote-*.xpi | head -n1)"
```

Rationale: filename now includes version suffix; the setup script must locate the freshly built artifact.

- [ ] **Step 7: Local smoke test — release build**

Run: `VERSION=1.2.3 make pack && make verify-pack VERSION=1.2.3`
Expected output ends with `verify-pack ok (1.2.3)` and produces `dist/hunote-1.2.3.xpi`.

- [ ] **Step 8: Local smoke test — dev build**

Run: `make pack && ls dist/`
Expected: `dist/hunote-YYYYMMDDhhmmss.xpi` with `manifest.version = "0.0.0.YYYYMMDDhhmmss"`. Confirm with:
`unzip -p dist/hunote-*.xpi manifest.json | jq -r .version` → prints `0.0.0.NNNNNNNNNNNNNN`.

- [ ] **Step 9: Update `.gitignore` for `build/`**

Add `build/` line to `.gitignore`:

```
.tmp/
node_modules/
coverage/
dist/
build/
*.xpi
__pycache__/
*.pyc
.env
```

- [ ] **Step 10: Commit**

```bash
git add Makefile tests/e2e/_setup.sh .gitignore
git commit -m "build(pack): tag-driven versioning via jq-patched build/manifest.json

- pack now stamps VERSION into build/manifest.json (X.Y.Z or 0.0.0.<ts>)
- verify-pack cross-checks stamped version
- lint target for web-ext lint
- clean removes build/
- _setup.sh locates versioned XPI filename"
```

---

## Task 3: Add `web-ext` devDependency + `.nvmrc`

**Files:**
- Create: `.nvmrc`
- Modify: `package.json`

- [ ] **Step 1: Create `.nvmrc`**

Write `.nvmrc` with a single line:

```
20
```

- [ ] **Step 2: Add web-ext devDependency**

Add to `package.json` `devDependencies` (alphabetical order):

```json
  "devDependencies": {
    "@vitest/coverage-v8": "^2.1.0",
    "jsdom": "^30.0.1",
    "vitest": "^2.1.0",
    "web-ext": "^10.6.0"
  }
```

- [ ] **Step 3: Add lint + pack npm scripts (mirror Makefile)**

Add to `package.json` `scripts`:

```json
  "scripts": {
    "test": "vitest run --passWithNoTests",
    "test:watch": "vitest",
    "coverage": "vitest run --coverage",
    "lint": "web-ext lint --source-dir=src --pretty",
    "pack": "make pack"
  }
```

- [ ] **Step 4: Install and verify lock file updates**

Run: `npm install`
Expected: `package-lock.json` regenerated (or created), `node_modules/web-ext/` present.

- [ ] **Step 5: Run web-ext lint locally**

Run: `npm run lint`
Expected: lint passes OR produces warnings only (no errors). If errors surface (e.g. missing icon key), fix `src/manifest.json` before proceeding; if only warnings, accept them (they will be visible in CI, no gate on warnings).

- [ ] **Step 6: Commit**

```bash
git add .nvmrc package.json package-lock.json
git commit -m "chore(deps): add web-ext@10.6.0 for lint, pin Node 20 via .nvmrc"
```

---

## Task 4: `docker/e2e.Dockerfile` — parametrized TB image

**Files:**
- Create: `docker/e2e.Dockerfile`

- [ ] **Step 1: Write the Dockerfile**

Create `docker/e2e.Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1
ARG TB_VERSION=140.14.0esr

FROM ubuntu:24.04

ARG TB_VERSION
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl xz-utils \
        xvfb x11-utils dbus-x11 \
        libgtk-3-0 libasound2t64 libdbus-glib-1-2 libx11-xcb1 libxt6 libpci3 \
        python3 python3-pip python3-venv \
        jq zip unzip make git \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://ftp.mozilla.org/pub/thunderbird/releases/${TB_VERSION}/linux-x86_64/en-US/thunderbird-${TB_VERSION}.tar.xz" \
        -o /tmp/tb.tar.xz \
    && mkdir -p /opt \
    && tar -xJf /tmp/tb.tar.xz -C /opt \
    && rm /tmp/tb.tar.xz \
    && ln -s /opt/thunderbird/thunderbird /usr/local/bin/thunderbird

RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir marionette-driver==5.0.1 pytest==8.3.3

ENV PATH="/opt/venv/bin:${PATH}" \
    DISPLAY=:99 \
    MOZ_HEADLESS=1

WORKDIR /hunote
CMD ["bash", "-c", "Xvfb :99 -screen 0 1280x1024x24 & sleep 1 && pytest tests/e2e/ -v"]
```

- [ ] **Step 2: Local smoke build (single TB version)**

Run: `docker build --build-arg TB_VERSION=140.14.0esr -t hunote-e2e:140 -f docker/e2e.Dockerfile .`
Expected: image builds without errors; final image `hunote-e2e:140` exists (`docker images | grep hunote-e2e`).

- [ ] **Step 3: Verify Thunderbird boots inside container**

Run: `docker run --rm hunote-e2e:140 bash -c 'thunderbird --version'`
Expected: prints `Thunderbird 140.14.0esr` (or exact matching version string).

- [ ] **Step 4: Commit**

```bash
git add docker/e2e.Dockerfile
git commit -m "ci(docker): parametrized Thunderbird e2e base image (ARG TB_VERSION)"
```

---

## Task 5: `docker/docker-compose.dovecot.yml` — Dovecot sidecar

**Files:**
- Create: `docker/docker-compose.dovecot.yml`

- [ ] **Step 1: Write the compose file**

Create `docker/docker-compose.dovecot.yml`:

```yaml
services:
  imap:
    image: docker.io/dovecot/dovecot:latest
    container_name: hunote-e2e-dovecot
    ports:
      - "1143:143"
    volumes:
      - ../tests/e2e/dovecot:/etc/dovecot:ro
    healthcheck:
      test: ["CMD-SHELL", "printf 'a1 LOGIN user@greenmail.local any\r\na2 LOGOUT\r\n' | nc -w2 127.0.0.1 143 | grep -q OK"]
      interval: 3s
      timeout: 4s
      retries: 20
      start_period: 5s

  tb:
    build:
      context: ..
      dockerfile: docker/e2e.Dockerfile
      args:
        TB_VERSION: ${TB_VERSION:-140.14.0esr}
    depends_on:
      imap:
        condition: service_healthy
    environment:
      HUNOTE_BACKEND: dovecot
      HUNOTE_IMAP_HOST: imap
      HUNOTE_GM_IMAP: "143"
      HUNOTE_IMAP_USER: user@greenmail.local
      HUNOTE_IMAP_PASS: any
    volumes:
      - ../:/hunote
    working_dir: /hunote
```

- [ ] **Step 2: Local smoke — bring up sidecar only**

Run: `docker compose -f docker/docker-compose.dovecot.yml up -d imap && docker compose -f docker/docker-compose.dovecot.yml ps`
Expected: `hunote-e2e-dovecot` shows `healthy` within ~30 s.

- [ ] **Step 3: Local smoke — run e2e Dovecot suite**

Run:
```bash
docker compose -f docker/docker-compose.dovecot.yml run --rm tb \
    bash -c 'make pack && pytest tests/e2e/persistence_roundtrip_test.py -v'
```
Expected: tests either pass, or fail with a clearly documented reason (network, TB startup) — capture the actual output. If they fail with pattern that the local (non-Docker) run also exhibits, that is acceptable for this task (blockers get their own follow-up task). Goal: prove the compose file connects the pieces.

- [ ] **Step 4: Tear down**

Run: `docker compose -f docker/docker-compose.dovecot.yml down`
Expected: containers removed.

- [ ] **Step 5: Commit**

```bash
git add docker/docker-compose.dovecot.yml
git commit -m "ci(docker): Dovecot sidecar compose for e2e (TB_VERSION arg)"
```

---

## Task 6: `docker/docker-compose.greenmail.yml` — GreenMail sidecar

**Files:**
- Create: `docker/docker-compose.greenmail.yml`

- [ ] **Step 1: Write the compose file**

Create `docker/docker-compose.greenmail.yml`:

```yaml
services:
  imap:
    image: docker.io/greenmail/standalone:2.1.0
    container_name: hunote-e2e-greenmail
    environment:
      GREENMAIL_OPTS: "-Dgreenmail.setup.test.all -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.auth.disabled"
    ports:
      - "4243:3143"
      - "4280:8080"
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://127.0.0.1:8080/api/service/readiness || exit 1"]
      interval: 3s
      timeout: 4s
      retries: 20
      start_period: 5s

  tb:
    build:
      context: ..
      dockerfile: docker/e2e.Dockerfile
      args:
        TB_VERSION: ${TB_VERSION:-140.14.0esr}
    depends_on:
      imap:
        condition: service_healthy
    environment:
      HUNOTE_BACKEND: dovecot   # config layout matches (Gmail-mimicry); host+port override below
      HUNOTE_IMAP_HOST: imap
      HUNOTE_GM_IMAP: "3143"
      HUNOTE_IMAP_USER: user@greenmail.local
      HUNOTE_IMAP_PASS: any
    volumes:
      - ../:/hunote
    working_dir: /hunote
```

- [ ] **Step 2: Local smoke — bring up sidecar**

Run: `docker compose -f docker/docker-compose.greenmail.yml up -d imap`
Expected: within ~20 s `docker compose -f docker/docker-compose.greenmail.yml ps` shows `healthy` for `imap`.

- [ ] **Step 3: Local smoke — run e2e against GreenMail**

Run:
```bash
docker compose -f docker/docker-compose.greenmail.yml run --rm tb \
    bash -c 'make pack && pytest tests/e2e/persistence_roundtrip_test.py -v'
```
Expected: same acceptance criterion as Task 5 step 3 — pipeline connects, tests report a real result.

- [ ] **Step 4: Tear down**

Run: `docker compose -f docker/docker-compose.greenmail.yml down`

- [ ] **Step 5: Commit**

```bash
git add docker/docker-compose.greenmail.yml
git commit -m "ci(docker): GreenMail sidecar compose for e2e (TB_VERSION arg)"
```

---

## Task 7: `tests/e2e/docker_backends.md` — dev docs

**Files:**
- Create: `tests/e2e/docker_backends.md`

- [ ] **Step 1: Write the doc**

Create `tests/e2e/docker_backends.md`:

```markdown
# E2E backends (Docker)

Two IMAP backends run in CI. Both are available locally via Docker Compose.

## Prerequisites

- Docker or podman with compose v2 (`docker compose ...`)
- At least 3 GB free disk (Thunderbird tarball + apt cache in image)

## Dovecot (Gmail-mimicry)

```bash
# One-off e2e run against Dovecot with Thunderbird 140 ESR
docker compose -f docker/docker-compose.dovecot.yml up -d imap
docker compose -f docker/docker-compose.dovecot.yml run --rm \
    -e TB_VERSION=140.14.0esr tb \
    bash -c 'make pack && pytest tests/e2e/ -v'
docker compose -f docker/docker-compose.dovecot.yml down
```

## GreenMail

```bash
docker compose -f docker/docker-compose.greenmail.yml up -d imap
docker compose -f docker/docker-compose.greenmail.yml run --rm \
    -e TB_VERSION=153.1.0esr tb \
    bash -c 'make pack && pytest tests/e2e/ -v'
docker compose -f docker/docker-compose.greenmail.yml down
```

## Thunderbird version matrix (matches CI)

- `140.14.0esr` — current ESR / declared floor
- `153.1.0esr` — next ESR
- `154.0` — latest stable

Override via `TB_VERSION=<version>` env var on the compose run command.

## Real Gmail

Not run in CI (credentials live in `dev-scripts/.env`, gitignored). Use
`tests/e2e/run-gmail.sh` for manual verification.
```

- [ ] **Step 2: Commit**

```bash
git add tests/e2e/docker_backends.md
git commit -m "docs(e2e): document Docker Compose backends for local dev"
```

---

## Task 8: `.github/workflows/ci.yml` — lint + unit + e2e matrix + build

**Files:**
- Create: `.github/workflows/ci.yml`

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]
  workflow_call:
    inputs:
      version:
        description: Version string to stamp into the XPI (empty → dev timestamp).
        required: false
        type: string
        default: ''

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  lint:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npm run lint

  unit:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - run: npm test

  e2e:
    runs-on: ubuntu-24.04
    strategy:
      fail-fast: false
      matrix:
        tb: ["140.14.0esr", "153.1.0esr", "154.0"]
        imap: [dovecot, greenmail]
    steps:
      - uses: actions/checkout@v4
      - name: Boot sidecar + run e2e
        env:
          TB_VERSION: ${{ matrix.tb }}
        run: |
          set -euo pipefail
          compose="docker/docker-compose.${{ matrix.imap }}.yml"
          docker compose -f "$compose" up -d imap
          docker compose -f "$compose" run --rm tb \
              bash -c 'make pack && pytest tests/e2e/ -v'
          docker compose -f "$compose" down

  build:
    needs: [lint, unit, e2e]
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version-file: .nvmrc
          cache: npm
      - run: npm ci
      - name: Build XPI
        env:
          VERSION: ${{ inputs.version || github.sha }}
        run: |
          make pack
          make verify-pack
      - uses: actions/upload-artifact@v4
        with:
          name: hunote-xpi
          path: dist/hunote-*.xpi
          if-no-files-found: error
          retention-days: 14
```

- [ ] **Step 2: Local syntax check via act (optional but recommended)**

Run: `command -v act && act -l -W .github/workflows/ci.yml || echo "act not installed — skip syntax check"`
Expected: `act` lists jobs `lint / unit / e2e / build` if installed; skip step otherwise (real validation happens on first push).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add CI workflow (lint + unit + 6-way e2e matrix + XPI build)"
```

---

## Task 9: `.github/workflows/release.yml` — tag-triggered publish

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    tags: ["v*"]

permissions:
  contents: write

jobs:
  extract-version:
    runs-on: ubuntu-24.04
    outputs:
      version: ${{ steps.v.outputs.version }}
    steps:
      - id: v
        run: |
          set -euo pipefail
          ref="${GITHUB_REF_NAME}"
          version="${ref#v}"
          if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
            echo "::error::tag $ref not semver X.Y.Z"
            exit 1
          fi
          echo "version=$version" >> "$GITHUB_OUTPUT"
          echo "resolved VERSION=$version"

  ci:
    needs: extract-version
    uses: ./.github/workflows/ci.yml
    with:
      version: ${{ needs.extract-version.outputs.version }}

  publish:
    needs: [extract-version, ci]
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with:
          name: hunote-xpi
          path: dist/
      - name: Sign + submit to ATN
        uses: kewisch/action-web-ext@v2
        with:
          cmd: sign
          source: dist/hunote-${{ needs.extract-version.outputs.version }}.xpi
          channel: listed
          apiUrlPrefix: https://addons.thunderbird.net/api/v4
          apiKey: ${{ secrets.ATN_SIGN_KEY }}
          apiSecret: ${{ secrets.ATN_SIGN_SECRET }}
      - name: Create GitHub Release
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          gh release create "${GITHUB_REF_NAME}" \
              "dist/hunote-${{ needs.extract-version.outputs.version }}.xpi" \
              --generate-notes
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add Release workflow (tag v* → ATN sign + GH Release)"
```

---

## Task 10: `.github/dependabot.yml` — weekly npm + gh-actions PRs

**Files:**
- Create: `.github/dependabot.yml`

- [ ] **Step 1: Write the config**

Create `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: npm
    directory: /
    schedule:
      interval: weekly
      day: monday
      time: "05:00"
      timezone: Europe/Moscow
    groups:
      minor-and-patch:
        applies-to: version-updates
        update-types: [minor, patch]
    open-pull-requests-limit: 5

  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
      day: monday
      time: "05:00"
      timezone: Europe/Moscow
    open-pull-requests-limit: 5
```

- [ ] **Step 2: Commit**

```bash
git add .github/dependabot.yml
git commit -m "chore(dependabot): weekly npm + gh-actions PRs (grouped patch+minor)"
```

---

## Task 11: `CONTRIBUTING.md` — release process

**Files:**
- Create: `CONTRIBUTING.md`

- [ ] **Step 1: Write the doc**

Create `CONTRIBUTING.md`:

````markdown
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

## Release process

Version is derived from the git tag — nothing to bump in source.

```bash
git checkout main && git pull
git tag v0.2.0
git push && git push --tags
```

GitHub Actions will then:

1. Reject the tag if it is not semver `X.Y.Z`.
2. Run the full CI matrix on the tagged commit (lint + unit + 6-way e2e).
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
````

- [ ] **Step 2: Commit**

```bash
git add CONTRIBUTING.md
git commit -m "docs: CONTRIBUTING.md with tag-driven release process"
```

---

## Task 12: PR + first-run verification

**Files:** none (verification only)

- [ ] **Step 1: Push branch**

Run: `git push -u origin feat-ci-cd-atn-publish`

- [ ] **Step 2: Open PR**

Run:
```bash
gh pr create --title "CI/CD + ATN publish" --body "$(cat <<'EOF'
## Summary

- Tag-driven versioning: `src/manifest.json` frozen at `0.0.0`, `package.json` `version` field removed.
- New `make pack` stamps version into `build/manifest.json` via `jq` (X.Y.Z or `0.0.0.<timestamp>`).
- GitHub Actions:
  - `ci.yml` — PR/push: lint (`web-ext`) + unit (`vitest`) + 6-way e2e matrix `[TB 140.14.0esr / 153.1.0esr / 154.0] × [dovecot / greenmail]` + XPI build artifact.
  - `release.yml` — tag `v*`: full CI + ATN sign via `kewisch/action-web-ext@v2` + `gh release create --generate-notes`.
- Dependabot: weekly npm + gh-actions.
- Docs: `CONTRIBUTING.md` + `tests/e2e/docker_backends.md`.

## Test plan

- [ ] `npm test` green.
- [ ] `make pack` locally → `dist/hunote-<ts>.xpi` with `manifest.version = "0.0.0.<ts>"`.
- [ ] `VERSION=1.2.3 make pack && make verify-pack VERSION=1.2.3` → `dist/hunote-1.2.3.xpi` with `manifest.version = "1.2.3"`.
- [ ] CI run on this PR: lint, unit, all 6 e2e cells green.
- [ ] After merge: tag `v0.1.1` in a follow-up → release.yml uploads to ATN and creates GH Release with auto notes.
EOF
)"
```

- [ ] **Step 3: Watch the CI run**

Run: `gh pr checks --watch`
Expected: all four jobs (`lint`, `unit`, `e2e (matrix cells)`, `build`) pass.
If a matrix cell flakes on TB startup, investigate the specific cell log (`gh run view --log-failed`) before rerunning.

- [ ] **Step 4: Merge + first tag**

After the PR is approved and merged to `main` (this step waits on human review, no automation):
```bash
git checkout main && git pull
git tag v0.1.1
git push --tags
gh run watch  # follow release.yml
```
Expected: `release.yml` succeeds end-to-end. Verify listing at [addons.thunderbird.net → your dev profile → HuNote → Versions](https://addons.thunderbird.net/developers/addon/hunote/versions).

---

## Self-review

**Spec coverage:**
- §2 Architecture (stack, workflows, matrix, secrets) → Tasks 8, 9, 10.
- §3 File Structure (new + modified files list) → all files accounted for across Tasks 1-11 (no CONTRIBUTING gap, no docker gap, no dependabot gap).
- §4 Component Responsibilities (Makefile, ci.yml, release.yml, dependabot, CONTRIBUTING) → Tasks 2, 8, 9, 10, 11.
- §5 Data flows (PR flow, Release flow, Dependabot flow) → covered by Tasks 8, 9, 10 respectively.
- §6 Error handling (malformed tag, lint errors, e2e flake, ATN failure, duplicate version, docker pull failure) → covered in `extract-version` regex gate (Task 9), CI structure (Task 8), CONTRIBUTING troubleshooting section (Task 11).
- §7 Testing strategy (unit unchanged, e2e matrix, verify-pack) → Tasks 2, 8.
- No gaps.

**Placeholder scan:** no "TBD", "TODO", "similar to Task N", or unshown code. All steps carry either concrete commands or full code.

**Type/name consistency:**
- Artifact name `hunote-xpi` — same in ci.yml upload and release.yml download (Tasks 8, 9).
- Compose service names `imap` / `tb` — same in both `dovecot` and `greenmail` compose files, referenced identically in CI matrix (Tasks 5, 6, 8).
- Env var names `TB_VERSION`, `VERSION`, `HUNOTE_BACKEND`, `HUNOTE_IMAP_HOST`, `HUNOTE_GM_IMAP`, `HUNOTE_IMAP_USER`, `HUNOTE_IMAP_PASS` — consistent across Dockerfile, both compose files, CI matrix step, and existing `backend_config.py` (Tasks 4, 5, 6, 8).
- `dist/hunote-<VERSION>.xpi` filename shape — same across `pack` output (Task 2), `_setup.sh` glob (Task 2 step 6), ci.yml artifact glob (Task 8), release.yml download path (Task 9), CONTRIBUTING docs (Task 11).
