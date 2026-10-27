# Self-hosted Server

**English** · [中文](README.zh.md)

A single-account Remote relay with credentials configured through environment variables. Its Web UI includes a landing page, sign-in, and device status page. The Server is deployed separately from the Host plugin bundle.

## Self-hosted Web flow

The `/` landing page links to `/app/login`; a successful sign-in continues to `/app/remote`. Point both Host and Client at the same Server URL and use the same account and password. Device credentials are persisted by the Server, while Web sessions use an HttpOnly cookie.

## Docker deployment

```bash
cd apps/server
cp .env.example .env
# Edit .env: set your account, password, and public URL
docker compose up -d --build
```

Open <http://localhost:8080>. Device credentials persist in the `server-data` volume. Stop the service with `docker compose down`.

If an older image fails to resolve `@dsh-remote/protocol`, update the source and rebuild with `docker compose build --no-cache server && docker compose up -d server`. The image explicitly includes the compiled protocol package and checks the Server import graph during the build. Rebuilding preserves the data volume.

The GitHub Tag workflow builds the production image. Put an HTTPS reverse proxy in front of it instead of exposing the Node listener directly to the public internet.

### Blank page or static assets returning 403

`DSH_SERVER_PUBLIC_URL` must match the browser-facing origin, including `http` / `https`, hostname, and any non-default port. Do not use the internal container address or a page path. For access through `https://remote.example.com`, set this in `.env`:

```dotenv
DSH_SERVER_PUBLIC_URL=https://remote.example.com
```

Apply it with `docker compose up -d --force-recreate server`; `docker compose restart` does not update environment variables. Add `--no-build` when using a prebuilt image. Keep the existing data volume; do not run `down -v`.

If JS/CSS returns 403 with `AUTH_INVALID` in the JSON response, compare this setting with the request's `Origin`. The Server checks origins before serving static assets, so the HTML may load while JS/CSS is rejected. The browser then reports an `application/json` MIME error and displays a blank page. Do not change MIME types or remove origin checks to bypass this. If the response comes from the reverse proxy, check its access rules; preserve the browser's original `Origin` header.

For protocol entry-resolution errors during Docker source builds, also inspect source permissions (`ls -ld packages/protocol packages/protocol/package.json`). The image normalizes read/directory-traversal permissions on published files and checks module loading as the final `node` user.

## Local setup

Requires Node.js 22 and pnpm 9.15.4. From the repository root:

```bash
pnpm install
pnpm --filter @dsh-remote/protocol build
pnpm --filter @dsh-remote/server build
cp apps/server/.env.example apps/server/.env
```

Edit `apps/server/.env` with your account and a password of at least 12 characters, then start:

```bash
cd apps/server
node --env-file=.env dist/main.js
```

Open <http://localhost:8080>. Set the same Server URL on your Host and Client, then sign in with the same account. Use an email address as the account name for compatibility with existing clients.

| Variable | Purpose / default |
| --- | --- |
| `DSH_SERVER_ACCOUNT` | Required login account |
| `DSH_SERVER_PASSWORD` | Required; at least 12 characters |
| `DSH_SERVER_PUBLIC_URL` | Browser-facing URL; default `http://localhost:8080` |
| `DSH_SERVER_HOST` | Listen / port-binding address; default `127.0.0.1`, use `0.0.0.0` for LAN access |
| `DSH_SERVER_PORT` | Default `8080` |
| `DSH_SERVER_DATA_FILE` | Default `data/state.json`, relative to the working directory |

For public access, use an HTTPS reverse proxy and set `DSH_SERVER_PUBLIC_URL` to your domain. The proxy must support WebSocket Upgrade at `/ws/v1/connect` with an idle timeout above 75 seconds.

## Features

- Device registration, credential refresh, device discovery, Control, and end-to-end encrypted Relay.
- Single-process operation with persistent data. Device credentials survive restarts; Web users sign in again. Changing the password requires devices to reauthorize.

Tests: `pnpm --filter @dsh-remote/server test`. Cross-machine and long-running validation remain pending. UI sources: [web/UPSTREAM.md](web/UPSTREAM.md).

## Release Tag checks

A release tag must match the versions in the root `package.json` and `packages/plugin/package.json`, for example `v0.4.15`. The Tag workflow runs workspace checks, tests, builds, npm plugin packing, browser-extension packaging, and SHA256 checksums; the Server image is built from the same tag.

Run the checks locally before creating a tag:

```bash
pnpm --filter './packages/**' -r build
pnpm -r check
pnpm -r test
NODE_ENV=production pnpm --workspace-concurrency=1 -r build
node scripts/verify-dsh-plugin.mjs
pnpm --dir packages/plugin pack --pack-destination /tmp/dsh-release-assets
```
