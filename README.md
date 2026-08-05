# GPlayer Node.js rewrite

This repository is a from-scratch Node.js/TypeScript rewrite of the supplied GDPlayer 4.8.3 application. The acceptance criterion is behavioral parity: every route, hosting adapter, streaming mode, admin workflow, background job, plugin hook, theme surface, configuration option, and edge case in the supplied source must have a tested Node equivalent.

The project is intentionally tracked against a generated source inventory rather than a hand-written feature shortlist. See [`docs/PARITY.md`](docs/PARITY.md), [`docs/parity-manifest.json`](docs/parity-manifest.json), and the [`Node plugin API`](docs/PLUGIN_API.md).

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

Create or converge the configured MySQL/MariaDB schema to the manifest version, then audit it:

```bash
pnpm db:migrate
pnpm audit:schema
```

The migrator uses an advisory database lock, adds or reconciles the 20 tables and four views without loading the dump's demo accounts, and retains unknown extension columns. It is an explicit deployment command rather than an automatic server-start mutation. Back up an existing database before any schema migration. Local socket-authenticated installations can set `DB_MASTER_SOCKET` (for example, `/tmp/mysql.sock`) for these database utilities.

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
