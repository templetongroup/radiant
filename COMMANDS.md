# Commands

## Codex model-list regression test

```bash
node scripts/test-codex-model-version.mjs
```

Checks the default client version, empty override fallback, explicit
`RADIANT_CODEX_CLIENT_VERSION` override, and visible/supported model filtering.
Runs the isolated model-list function with a stubbed response; no credentials or
network calls. Per-run API cost: $0.

`RADIANT_CODEX_CLIENT_VERSION` overrides the client version advertised when
requesting ChatGPT subscription models. The default is `0.160.1`. Set it in the
server process environment before starting Radiant if a newer backend model
catalog requires a newer client version.
