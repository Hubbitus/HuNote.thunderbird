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
    bash -c 'make pack && ./tests/e2e/ci_bootstrap.sh'
docker compose -f docker/docker-compose.dovecot.yml down
```

## GreenMail

```bash
docker compose -f docker/docker-compose.greenmail.yml up -d imap
docker compose -f docker/docker-compose.greenmail.yml run --rm \
    -e TB_VERSION=153.1.0esr tb \
    bash -c 'make pack && ./tests/e2e/ci_bootstrap.sh'
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
