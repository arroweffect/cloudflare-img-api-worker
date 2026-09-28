# AFX Engine Image API Worker

A Cloudflare Worker for managing and serving images via R2 storage and Cloudflare Image Transformations.

**Public hostnames:** `img.afxengine.com`, `img.arroweffect.com`.
**Image origins (R2 custom domains):** `cdn.afxengine.com` (bucket `media`), `cdn-staging.afxengine.com` (bucket `media-staging`).

- Upload, delete, and purge images via authenticated API endpoints
- Serve and transform images on-the-fly (resize, format negotiation, quality)
- SVG passthrough (served directly without transformation)
- Automatic fallback to origin if image transformation fails
- Error responses are never cached; only successful responses get long-lived cache headers

---

## Buckets

Every read, upload and delete picks its bucket from the key's first path segment:

| Key | Bucket | Origin |
| --- | --- | --- |
| First segment ends in `-staging`, `-preview` or `-sandbox` (`afx-site-staging/…`, `jhb-site-preview/…`) | `media-staging` | `CDN_STAGING_ORIGIN` |
| Anything else (`afx-site/…`, `clients/…`) | `media` | `CDN_ORIGIN` |
| Any key requested on `img.arroweffect.com` | `media` | `ARROWEFFECT_ORIGIN` |

The AFX CMS writes production to `media` and every other tier to `media-staging`; URLs are the same
`img.afxengine.com/<key>` for all of them. `/purge` purges a URL and touches no bucket.

---

## Endpoints

### `POST /upload`

Uploads a base64-encoded image to R2.

**Headers:**

```
Authorization: Bearer <your-secret-token>
Content-Type: application/json
```

**Body:**

```json
{
	"path": "clients/example/cover.jpg",
	"contentType": "image/jpeg",
	"fileBase64": "<base64-encoded file>"
}
```

**Response:** `201 Created`

Path is validated — must not start with `/` or `.`, contain `..`, `//`, or control characters.

---

### `POST /delete`

Deletes an image from R2.

**Headers:**

```
Authorization: Bearer <your-secret-token>
Content-Type: application/json
```

**Body:**

```json
{
	"path": "clients/example/cover.jpg"
}
```

**Response:**

```json
{
	"success": true,
	"deleted": "clients/example/cover.jpg"
}
```

Returns 404 if the file does not exist. Path validation is the same as upload. The key is marked deleted before its variants are purged (see `/tombstone`).

---

### `POST /purge`

Drops the cached variants of one or more image URLs, or of whole tenants, from the worker's cache, and nothing else: the next request re-transforms. For a deleted object use `/tombstone`, which also keeps it from being re-cached. Zone-level purges never reach a Worker's cache, so this is the only way in.

**Headers:**

```
Authorization: Bearer <your-secret-token>
Content-Type: application/json
```

**Body:** one of

```json
{ "url": "https://img.afxengine.com/clients/example/cover.jpg" }
{ "urls": ["https://img.afxengine.com/clients/example/cover.jpg", "..."] }
{ "tenants": ["acme"] }
```

Every response is tagged `key:<object key>`, and a `<base>/<slug>/…` response `tenant:<slug>` as well, so a url purge drops every format and query-string variant of that object and a tenant purge is one tag whatever the tenant's size. At most 30 urls and tenants per call. `urls` and `tenants` combine.

**Response:** `200` when the runtime accepted the purge, `502` with `errors` when it refused (rate limit)

```json
{
  "success": true,
  "purged": ["clients/example/cover.jpg"],
  "purgedTenants": []
}
```

---

### `POST /tombstone`

For objects the caller removed from the bucket itself: marks each object key, and each tenant, deleted in the `DELETED` KV namespace for 30 days, then purges their tags. A purge alone does not keep a deleted object gone: the transform layer's own cache of past results, which nothing here can purge, re-served variants of a deleted object for minutes, and a variant cut then is cached for a year.

```json
{ "keys": ["afx-site/acme/media_01m3…/photo.jpg"], "tenants": ["afx-site-staging/acme"] }
```

A tenant is `<base>/<slug>`, because slugs repeat across envs. A marked tenant refuses only media minted before the mark (the media id's TypeID timestamp), so a slug taken again after a purge serves its new media. At most 30 keys and tenants per call; safe to repeat. Response as `/purge`, with `tombstoned` and `tombstonedTenants`.

Every cache miss checks the markers beside the transform, not before it, and answers `404` `no-store` when either matches (an `image_deleted` log line). Hits never reach the check. A KV failure fails open. A new marker can take up to a minute to reach every location, which is why the CMS calls this twice, the second time two minutes later.

---

### `GET /*`

Serves and transforms images on-the-fly using [Cloudflare Image Transformations](https://developers.cloudflare.com/images/transform-images/).

**Supported query parameters:** `width`, `height`, `quality`, `fit`, `dpr`, `gravity`, `crop`, `pad`, `background`, `draw`, `rotate`, `trim`, `format`

**Format negotiation:** Automatically selects avif, webp, or jpeg based on the `Accept` header. Pass `format=png` (or `webp`, `avif`, etc.) to override. `format=auto` uses content negotiation (the default).

**Example:**

```
GET /clients/example/cover.jpg?width=800&quality=80
```

**Cache behavior:** the worker owns its cache ([Workers Cache](https://developers.cloudflare.com/workers/cache/)). The uncached gateway (`default` export) normalises `Accept` into a key, `/<CACHE_KEY_VERSION>/<avif|webp|jpeg|asked|svg>/<path>?<query>`, and calls the cached `Transform` entrypoint under it, so one entry serves every browser that negotiates the same format. Entries are tiered (edge, then an upper tier) and survive deploys (`cross_version_cache`): a key's bytes never change, and a change to the transform's output is rolled out by bumping `CACHE_KEY_VERSION` in `src/index.js`, which retires every older entry atomically with the deploy. The headers below decide what is stored:

- Transformed responses (`cf-resized: internal=…`): `Cache-Control: public, max-age=31536000, immutable` (a key is written once and never reused) and `Cache-Tag: key:<object key>[,tenant:<slug>]`
- Untransformed originals: `Cache-Control: public, max-age=60` plus `X-Img-Untransformed: <reason>` (for example `429 err=9422` when the transformation quota is exhausted, or `no cf-resized header` when transformations are not enabled on the zone), and a `image_untransformed` log line
- 404 and error responses: `Cache-Control: no-store`

**Fallback:** If Cloudflare image transformation fails, the worker retries by fetching the original untransformed image from the origin. The short cache on that response means a fixed zone or quota takes effect within a minute; probe with `curl -sI '<url>?width=64' | grep -i -e cf-resized -e x-img-untransformed`.

**SVGs:** Served directly without transformation.

---

## Authentication

- **`IMG_API_SECRET`** — gates inbound requests to this worker. Callers must send it as a Bearer token on `POST /upload`, `/delete`, `/purge`, and `/tombstone`. `GET` requests for serving images do not require auth.
Uploads, deletes and purges need no Cloudflare API token — they use the R2 bindings (`MEDIA_BUCKET`, `MEDIA_STAGING_BUCKET`) and the worker's own cache, which are authenticated implicitly by the worker's deployment identity.

Inbound bearer header for the protected endpoints:

```
Authorization: Bearer <IMG_API_SECRET>
```

---

## Environment Variables

| Variable         | Type    | Purpose                                                                                  |
| ---------------- | ------- | ---------------------------------------------------------------------------------------- |
| `IMG_API_SECRET` | Secret  | Bearer token callers send to authenticate against `/upload`, `/delete`, `/purge`, `/tombstone` |
| `CDN_ORIGIN`     | Var     | Base URL the worker fetches `media` images from (R2 custom domain)                       |
| `CDN_STAGING_ORIGIN` | Var | Base URL the worker fetches `media-staging` images from (R2 custom domain)               |
| `ARROWEFFECT_ORIGIN` | Var | `media` through a custom domain on the arroweffect.com zone. Transforms only run on an origin in the requesting zone; a cross-zone origin is returned untransformed. |
| `MEDIA_BUCKET`   | Binding | R2 bucket `media` — used for upload/delete; no separate token needed                     |
| `MEDIA_STAGING_BUCKET` | Binding | R2 bucket `media-staging` — used for upload/delete of non-production keys          |
| `DELETED`        | Binding | KV namespace of deleted markers (`key:<key>`, `tenant:<base>/<slug>`), written by `/delete` and `/tombstone`, read on every miss |

Secrets are set via `wrangler secret put <NAME>`. Plain vars and the R2 bucket binding are declared in `wrangler.jsonc`.

---

## Error Logging

All error responses emit structured JSON logs with Cloudflare edge metadata:

```json
{
	"level": "error",
	"type": "image_not_found",
	"path": "/example.jpg",
	"origin": "https://cdn.afxengine.com/example.jpg",
	"status": 404,
	"colo": "DFW",
	"country": "US",
	"city": "Dallas",
	"ray": "..."
}
```

Filter by `type` in Cloudflare's observability dashboard:

- `image_not_found` — 404s
- `image_fetch_failed` — 502s and other upstream failures

---

## Development

**Prerequisites:** Node.js 22+, pnpm

```bash
pnpm install
pnpm dev          # Start local dev server via wrangler
```

Create a `.dev.vars` file (gitignored) with your local worker secrets — see `.dev.vars.example`:

```
IMG_API_SECRET="your-local-secret"
```

### Manual testing

There are helper scripts in `tools/` for testing endpoints against a deployed worker (or your local `wrangler dev`):

```bash
pnpm test:upload   # Upload a test image
pnpm test:purge    # Purge a test image from cache
pnpm test:delete   # Delete a test image
```

These read `IMG_API_SECRET` and `IMG_API_BASE` from `.env` — see `.env.example`. `IMG_API_SECRET` must match whatever value the target worker has configured (production secret, or your `.dev.vars` value when pointing at `wrangler dev`).

---

## Testing

Tests use [Vitest](https://vitest.dev/) with [@cloudflare/vitest-pool-workers](https://developers.cloudflare.com/workers/testing/vitest-integration/) to run in the Workers runtime.

```bash
pnpm test         # Watch mode
pnpm test -- run  # Single run
```

**Test coverage:**

- `isValidPath` — path validation edge cases (traversal, control chars, etc.)
- Routing — correct handler dispatch by method and path
- Auth — missing, invalid, and malformed tokens
- Upload/delete validation — path rejection, missing fields
- Cache headers — errors return `no-store`, not long-lived cache
- Bucket routing — each tier's keys read, upload and delete against their own bucket and origin; `img.arroweffect.com` always uses `media`

---

## CI/CD

GitHub Actions runs on push to `master` and on pull requests:

1. **Test** — `pnpm test -- run`
2. **Deploy** — `wrangler deploy` (only on push to `master`, after tests pass)

The deploy step requires two GitHub repository secrets:

| Secret                  | Purpose                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | Cloudflare API token with Workers Scripts (Edit) and Workers Routes (Edit) permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID                                                                  |
