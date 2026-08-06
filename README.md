# GPlayer

GPlayer is a self-hosted media player and streaming gateway built with Node.js and TypeScript. It turns supported provider links, HLS and DASH manifests, and direct media URLs into secure player, embed, download, and request links from one responsive interface.

[View the public product page](https://rsm23.github.io/gplayer/)

## Features

- 69 registered media-host adapters, with a 66-host public catalog.
- HLS, MPEG-DASH, MP4, live-stream, byte-range, and cached media delivery.
- Encrypted and authenticated player queries, portable iframe embeds, download links, and request links.
- Provider-aware extraction with canonical URL parsing, fallback sources, subtitles, posters, and filmstrips.
- Server-side provider credentials, cookies, request headers, and referers.
- Load balancing, source recovery, throttling, cache controls, and replica-database fallback.
- Administration for users, videos, subtitles, settings, sessions, plugins, Google Drive accounts, and background jobs.
- Google Drive sharing, mirroring, backup queues, and ranged delivery.
- Plugin pages, hooks, filters, widgets, public assets, configuration forms, and isolated Node.js background modules.
- Responsive, themeable shadcn UI with installable PWA metadata and an offline page.

The current enabled-host catalog and its verification status are available in [`docs/live-host-support.json`](docs/live-host-support.json).

## Requirements

- Node.js 24 or newer
- pnpm 11.10 or newer
- MySQL or MariaDB

## Quick start

```bash
git clone https://github.com/rsm23/gplayer.git
cd gplayer
pnpm install
cp .env.example .env
```

Create an empty database, then update `.env` with its connection details. Set `BASE_URL` to the public application URL and replace `SECURE_SALT` with a long random value. For example:

```bash
openssl rand -hex 32
```

Create the application schema and start the development server:

```bash
pnpm db:migrate
pnpm dev
```

Open `http://127.0.0.1:3000/`. The administrator area is available at `/administrator/` after an active administrator account exists in the database.

## Using GPlayer

1. Open the public generator.
2. Paste a supported provider link or a direct media URL.
3. Optionally add fallback sources, a poster, and subtitle tracks.
4. Generate the player links.
5. Copy the embed code, player URL, download URL, or request URL for your use case.

The GitHub Pages site is a static product preview. Run the Node.js application to resolve sources and generate authenticated links.

## Configuration

The example environment file documents all available runtime and database values. The most important settings are:

| Variable | Purpose |
| --- | --- |
| `HOST` / `PORT` | Address and port used by the Node.js server. |
| `BASE_URL` | Canonical public URL, including the trailing slash. |
| `ADMIN_DIR` | Administrator route segment. |
| `SLUG_EMBED` | Public embed route segment. |
| `SLUG_DOWNLOAD` | Public download route segment. |
| `SLUG_REQUEST` | Public request route segment. |
| `SECURE_SALT` | Secret used to protect authenticated player queries. |
| `BUFFER_SIZE` | Main streaming buffer size in bytes. |
| `SMALL_BUFFER_SIZE` | Smaller buffer used by eligible delivery paths. |
| `MAX_DOWNLOAD_SPEED` | Optional download speed limit; `0` disables it. |
| `TRUST_PROXY` | Trusted reverse-proxy IP address or CIDR list. |
| `DB_MASTER_*` | Primary MySQL or MariaDB connection. |
| `DB_REPLICA_*` | Optional read-replica connection. |

Keep provider credentials and request context on the server. Do not expose them in public HTML, browser code, or generated links.

When deploying behind a reverse proxy, set `TRUST_PROXY` to the proxy's explicit IP address or CIDR range. Its default is `false`; use `true` only when the application is isolated behind a fully trusted proxy topology.

## Production

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm db:migrate
NODE_ENV=production pnpm start
```

Use a process manager for restarts, serve the application behind TLS, back up the database before schema changes, and run migrations as an explicit deployment step.

## UI development

Application UI elements use the repository-owned shadcn Base Nova component layer:

- components: [`src/components/ui`](src/components/ui)
- registry configuration: [`components.json`](components.json)
- server-rendered composition: [`src/ui/shadcn-html.tsx`](src/ui/shadcn-html.tsx)
- design tokens: [`src/styles/globals.css`](src/styles/globals.css)

After changing components or design tokens, run:

```bash
pnpm build:ui
```

This regenerates the static product page, offline document, and shared UI stylesheet without adding a client-side hydration requirement.

## Useful commands

| Command | Description |
| --- | --- |
| `pnpm dev` | Start the development server with file watching. |
| `pnpm build` | Build the shadcn UI assets and compile TypeScript. |
| `pnpm start` | Run the compiled production server. |
| `pnpm test` | Run the Vitest suite. |
| `pnpm typecheck` | Type-check the project without emitting files. |
| `pnpm check` | Run type-checking, tests, UI generation, and the production build. |
| `pnpm db:migrate` | Converge the configured database to the current schema. |
| `pnpm audit:schema` | Audit the configured database schema. |
| `pnpm build:ui` | Rebuild the shadcn-backed static and shared UI assets. |

## Contributing

Contributions are welcome.

1. Fork the repository and create a focused branch.
2. Install dependencies with `pnpm install`.
3. Make the change and add or update tests for affected behavior.
4. Run `pnpm check`.
5. Open a pull request that explains the change, its user impact, and how it was verified.

For provider work, include deterministic parser or protocol fixtures and update [`docs/live-host-support.json`](docs/live-host-support.json) when public catalog support changes. Keep network access bounded, validate redirects and DNS targets, and preserve the server-side credential boundary.

For UI work, compose the existing shadcn components and preserve native form names, routes, accessibility semantics, progressive enhancement, and established JavaScript hooks.

## Documentation

- [`docs/PLUGIN_API.md`](docs/PLUGIN_API.md) — plugin manifests, pages, hooks, widgets, assets, and background modules.
- [`docs/live-host-support.json`](docs/live-host-support.json) — registered and publicly enabled host support.
- [`docs/VERIFICATION.md`](docs/VERIFICATION.md) — capability verification summary.
- [`docs/verification-matrix.json`](docs/verification-matrix.json) — machine-readable verification evidence and boundaries.

## Security and responsible use

- Never commit secrets, provider credentials, cookies, tokens, or database passwords.
- Use a strong unique `SECURE_SALT` in every deployment.
- Restrict administration and database access to trusted networks and accounts.
- Only process media you are authorized to access, stream, or redistribute.
- Report security issues privately to the repository maintainers before public disclosure.
