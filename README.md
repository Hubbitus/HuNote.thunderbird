# HuNote

Thunderbird 140+ extension that stores per-message notes on the IMAP server as `X-Hu-note*` message headers. Notes sync across devices without a separate backend.

Cycle A MVP. Full documentation, build, and CI arrive in cycle E.

## Design

See `docs/superpowers/specs/2026-08-14-hunote-cycle-a-design.md`.

## Development

```
pnpm install
pnpm test
```

Manual install: pack `src/` into `hunote.xpi` (zip contents of `src/` at the root), then in Thunderbird → Tools → Add-ons → gear → "Install Add-on From File".
