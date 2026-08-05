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

The migrator uses an advisory database lock, adds or reconciles the 20 tables and four views without loading the dump's demo accounts, and retains unknown extension columns. Older databases also receive the recovered data upgrades before constraints are rebuilt: legacy slugs and raw statistics user agents are preserved, renamed hosting identifiers are normalized, duplicate keys are consolidated, and rows that cannot satisfy the supplied foreign-key relationships are removed. It is an explicit deployment command rather than an automatic server-start mutation. Back up an existing database before any schema migration. Local socket-authenticated installations can set `DB_MASTER_SOCKET` (for example, `/tmp/mysql.sock`) for these database utilities.

The version-84 compatibility fixture can be exercised against a disposable local MySQL/MariaDB database with:

```bash
GPLAYER_TEST_MYSQL_SOCKET=/tmp/mysql.sock pnpm vitest run test/schema-migrator-mysql.test.ts
```

Migrate legacy subtitle and uploaded-image files into the Node public roots with:

```bash
pnpm assets:migrate -- /absolute/path/to/legacy-install
```

This command recovers files from `subtitles`, `uploads/subtitles`, and `uploads/images`, flattens their nested layouts exactly as the legacy migration did, and publishes them under `public/uploads/subtitles` and `public/uploads/images`. Unlike the legacy copier, it never overwrites a different destination: byte-identical files are deduplicated, conflicts and unsafe executable/server-control files are reported, and a source file is removed only after the destination has passed a SHA-256 integrity check. Use `--copy-only` to retain every source file, or `--public-root=/absolute/path/to/public` to target a deployed public directory. Back up the legacy installation first.

At playback time, the authenticated subtitle proxy converts every supplied SRT, VTT, ASS, SUB, STL, DFXP, TTML, SBV, and TXT family into WebVTT. Conversion is byte-safe for UTF-8, UTF-16, Windows-1252, and binary EBU STL/ISO-6937 input and preserves the supplied cache-on-first-read behavior without loading PHP.

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
