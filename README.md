# ArrowEffect Image API Worker

This Cloudflare Worker provides an API for managing and serving images via Cloudflare R2 + Cloudflare Images.

It allows:
✅ Uploading images to R2
✅ Deleting images from R2
✅ Purging cached images from Cloudflare CDN
✅ Serving and transforming images on-the-fly

---

## 🌟 **Endpoints**

### `POST /upload`

Uploads a base64-encoded image to R2.

#### Request headers:

```
Authorization: Bearer <your-secret-token>
Content-Type: application/json
```

#### Request body:

```json
{
	"path": "clients/example/cover.jpg",
	"contentType": "image/jpeg",
	"fileBase64": "<base64-encoded file>"
}
```

#### Success response:

```
201 Created
Uploaded clients/example/cover.jpg successfully
```

---

### `POST /delete`

Deletes an image from R2.

#### Request headers:

```
Authorization: Bearer <your-secret-token>
Content-Type: application/json
```

#### Request body:

```json
{
	"path": "clients/example/cover.jpg"
}
```

#### Success response:

```json
{
	"success": true,
	"deleted": "clients/example/cover.jpg"
}
```

---

### `POST /purge`

Purges the Cloudflare cache for a given image URL.

#### Request headers:

```
Authorization: Bearer <your-secret-token>
Content-Type: application/json
```

#### Request body:

```json
{
	"url": "https://img.arroweffect.com/clients/example/cover.jpg"
}
```

#### Success response:

```json
{
	"success": true,
	"purged": "https://img.arroweffect.com/clients/example/cover.jpg",
	"cloudflare": {
		/* Cloudflare API purge response */
	}
}
```

---

### `GET /*`

Serves and transforms images on-the-fly.

#### Example request:

```
GET /clients/example/cover.jpg?width=800&format=webp
```

#### Example response:

Returns transformed image with headers:

```
Cache-Control: public, max-age=31536000, stale-while-revalidate=86400
Content-Type: image/webp
```

---

## 🔐 **Authentication**

All API routes require an `Authorization` header:

```
Authorization: Bearer <your-secret-token>
```

The secret token is configured via the `IMAGE_API_SECRET` environment variable.

---

## ⚙ **Environment variables**

| Variable           | Purpose                              |
| ------------------ | ------------------------------------ |
| `IMAGE_API_SECRET` | Secret token required for API access |
| `CF_API_TOKEN`     | Token for Cloudflare cache purge API |
| `ZONE_ID`          | Cloudflare Zone ID for the domain    |
| `MEDIA_BUCKET`     | Bound R2 bucket for image storage    |

---

## 💡 **Example usage**

### Upload an image

```bash
curl -X POST https://img.arroweffect.com/upload   -H "Authorization: Bearer YOUR_TOKEN"   -H "Content-Type: application/json"   -d '{"path":"tests/test.jpg","contentType":"image/jpeg","fileBase64":"<encoded>"}'
```

### Delete an image

```bash
curl -X POST https://img.arroweffect.com/delete   -H "Authorization: Bearer YOUR_TOKEN"   -H "Content-Type: application/json"   -d '{"path":"tests/test.jpg"}'
```

### Purge cache

```bash
curl -X POST https://img.arroweffect.com/purge   -H "Authorization: Bearer YOUR_TOKEN"   -H "Content-Type: application/json"   -d '{"url":"https://img.arroweffect.com/tests/test.jpg"}'
```

---

## 🚀 **Notes**

- Serving image requests (`GET`) does not require auth.
- Uploads are cached for 1 year (`max-age=31536000`).
- Deleted files will 404, but Cloudflare cached copies may still respond `HIT` until cache is purged.
- Consider versioning file paths (e.g. `/v2/cover.jpg`) to avoid cache invalidation headaches.

---

## 📌 **Future improvements**

- Add OpenAPI spec
- Support multipart upload for large files
- Add cache tags for more flexible purging
