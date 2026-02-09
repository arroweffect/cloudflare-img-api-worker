# ArrowEffect Image API Worker

A Cloudflare Worker for managing and serving images via R2 storage and Cloudflare Image Transformations.

- Upload, delete, and purge images via authenticated API endpoints
- Serve and transform images on-the-fly (resize, format negotiation, quality)
- SVG passthrough (served directly without transformation)
- Automatic fallback to origin if image transformation fails
- Error responses are never cached; only successful responses get long-lived cache headers

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

Returns 404 if the file does not exist. Path validation is the same as upload.

---

### `POST /purge`

Purges the Cloudflare CDN cache for a given image URL.

**Headers:**

```
Authorization: Bearer <your-secret-token>
Content-Type: application/json
```

**Body:**

```json
{
  "url": "https://img.arroweffect.com/clients/example/cover.jpg"
}
```

**Response:**

```json
{
  "success": true,
  "purged": "https://img.arroweffect.com/clients/example/cover.jpg",
  "cloudflare": { ... }
}
```

---

### `GET /*`

Serves and transforms images on-the-fly using [Cloudflare Image Transformations](https://developers.cloudflare.com/images/transform-images/).

**Supported query parameters:** `width`, `height`, `quality`, `fit`, `dpr`, `gravity`, `crop`, `pad`, `background`, `draw`, `rotate`, `trim`

**Format negotiation:** Automatically selects avif, webp, or jpeg based on the `Accept` header.

**Example:**

```
GET /clients/example/cover.jpg?width=800&quality=80
```

**Cache behavior:**
- Successful responses: `Cache-Control: public, max-age=31536000, stale-while-revalidate=86400`
- 404 and error responses: `Cache-Control: no-store`

**Fallback:** If Cloudflare image transformation fails, the worker retries by fetching the original untransformed image from the origin.

**SVGs:** Served directly without transformation.

---

## Authentication

The `POST` endpoints (`/upload`, `/delete`, `/purge`) require a Bearer token:

```
Authorization: Bearer <your-secret-token>
```

`GET` requests for serving images do not require authentication.

---

## Environment Variables

| Variable           | Type    | Purpose                                          |
| ------------------ | ------- | ------------------------------------------------ |
| `IMAGE_API_SECRET` | Secret  | Bearer token for authenticating API requests     |
| `CF_API_TOKEN`     | Secret  | Cloudflare API token for cache purge             |
| `ZONE_ID`          | Secret  | Cloudflare Zone ID for the domain                |
| `MEDIA_BUCKET`     | Binding | R2 bucket binding for image storage              |

Secrets are set via `wrangler secret put <NAME>`. The R2 bucket is configured in `wrangler.jsonc`.

---

## Error Logging

All error responses emit structured JSON logs with Cloudflare edge metadata:

```json
{
  "level": "error",
  "type": "image_not_found",
  "path": "/example.jpg",
  "origin": "https://media.arroweffect.com/example.jpg",
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

Create a `.dev.vars` file for local secrets:

```
IMAGE_API_SECRET=your-local-secret
```

### Manual testing

There are helper scripts in `tools/` for testing endpoints against the live worker:

```bash
pnpm test:upload   # Upload a test image
pnpm test:purge    # Purge a test image from cache
pnpm test:delete   # Delete a test image
```

These read `IMG_API_TOKEN` from `.env`.

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

---

## CI/CD

GitHub Actions runs on push to `master` and on pull requests:

1. **Test** — `pnpm test -- run`
2. **Deploy** — `wrangler deploy` (only on push to `master`, after tests pass)

The deploy step requires two GitHub repository secrets:

| Secret                   | Purpose                                                                 |
| ------------------------ | ----------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`   | Cloudflare API token with Workers Scripts (Edit) and Workers Routes (Edit) permissions |
| `CLOUDFLARE_ACCOUNT_ID`  | Cloudflare account ID                                                   |
