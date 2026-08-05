# GPlayer Node.js rewrite

This repository is a from-scratch Node.js/TypeScript rewrite of the supplied GDPlayer 4.8.3 application. The acceptance criterion is behavioral parity: every route, hosting adapter, streaming mode, admin workflow, background job, plugin hook, theme surface, configuration option, and edge case in the supplied source must have a tested Node equivalent.

The project is intentionally tracked against a generated source inventory rather than a hand-written feature shortlist. See [`docs/PARITY.md`](docs/PARITY.md) and [`docs/parity-manifest.json`](docs/parity-manifest.json).

## Development

Use Node.js 24.7 or newer.

```bash
pnpm install
cp .env.example .env
pnpm dev
```

Validation:

```bash
pnpm check
```

Refresh the supplied-source inventory and non-PHP assets:

```bash
pnpm inventory:legacy -- /absolute/path/to/gdplayer-483
pnpm sync:legacy-assets -- /absolute/path/to/gdplayer-483
```

Inspect one YAK Pro-obfuscated PHP method with decoded string literals:

```bash
pnpm inspect:legacy-php -- /absolute/path/to/File.php methodName
```

The Node runtime never loads PHP. PHP files remain only in the external source snapshot used to derive behavior and parity fixtures.

When the server is deployed behind a reverse proxy, set `TRUST_PROXY` to that proxy's explicit IP address or CIDR range (comma-separated for multiple proxies). It defaults to `false`; setting it to `true` trusts arbitrary forwarding chains and should only be used in a fully isolated proxy topology.
