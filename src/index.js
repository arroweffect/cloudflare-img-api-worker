import { WorkerEntrypoint } from 'cloudflare:workers';

/**
 * The gateway: uncached (wrangler.jsonc `exports.default`), so it runs on every
 * request. Admin routes are handled here; every other path is an image read,
 * which it hands to the cached `Transform` entrypoint under a key it computes.
 */
export default {
	/**
	 * @param {Request} request - Incoming HTTP request
	 * @param {Record<string, any>} env - Worker environment bindings
	 * @param {ExecutionContext} ctx
	 * @returns {Promise<Response>}
	 */
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		const method = request.method;
		const pathname = url.pathname;

		if (pathname === '/upload' && method === 'POST') {
			return handleUpload(request, env);
		} else if (pathname === '/purge' && method === 'POST') {
			return handlePurge(request, env, ctx);
		} else if (pathname === '/delete' && method === 'POST') {
			return handleDelete(request, env, ctx);
		} else if (pathname === '/tombstone' && method === 'POST') {
			return handleTombstone(request, env, ctx);
		} else {
			return serveImage(request, ctx);
		}
	},
};

/**
 * The cached entrypoint (wrangler.jsonc `exports.Transform`): Workers Cache
 * sits in front of it, keyed by what the gateway passes as `cf.cacheKey`, and
 * survives deploys (`cross_version_cache`) because a key's bytes never change.
 */
export class Transform extends WorkerEntrypoint {
	/**
	 * The deleted check runs beside the transform, not before it, so a live
	 * object's miss waits for nothing it did not already wait for.
	 */
	async fetch(request) {
		const path = new URL(request.url).pathname;
		const [response, deleted] = await Promise.all([handleFetchAndTransform(request, this.env), isDeleted(path, this.env)]);
		if (!deleted) return response;
		await response.body?.cancel();
		console.log(JSON.stringify({ level: 'info', type: 'image_deleted', path, colo: request.cf?.colo }));
		return new Response('Image not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
	}

	/**
	 * Drops every cached variant of each object and every entry of each tenant,
	 * by tag: a path prefix does not match an entry stored under a custom
	 * `cf.cacheKey`. Scoped to this entrypoint by the runtime, which is why the
	 * gateway cannot purge on its own.
	 * @param {{ keys?: string[], tenants?: string[] }} what - object keys (no leading slash); tenant slugs
	 * @returns {Promise<{ success: boolean, errors?: { code: number, message: string }[] }>}
	 */
	async purge({ keys = [], tenants = [] }) {
		const cache = this.ctx.cache;
		if (!cache?.purge) return { success: false, errors: [{ code: 0, message: 'cache purge is unavailable in this runtime' }] };
		return cache.purge({ tags: [...keys.map(keyTag), ...tenants.map(tenantTag)] });
	}
}

/**
 * The tags of a cached response: its object key always, and its tenant when
 * the key is `<base>/<slug>/<media id>/…`, so one tag purge retires either an
 * object's every variant or a tenant's every entry.
 * @param {string} pathname - `/<key>`
 * @returns {string[]}
 */
export function cacheTagsFor(pathname) {
	const key = pathname.replace(/^\/+/, '');
	const segments = key.split('/');
	const tags = [keyTag(key)];
	if (segments.length >= 4) tags.push(tenantTag(segments[1]));
	return tags;
}

function keyTag(key) {
	return `key:${key}`;
}

function tenantTag(slug) {
	return `tenant:${slug}`;
}

/**
 * How long a deleted marker outlives the purge. The transform layer's own
 * cache of past results, which nothing here can purge, re-served a deleted
 * object's variants for minutes; a month is far past that, and a key is never
 * reused, so an object marker never outlives anything live.
 */
const DELETED_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Marks objects and tenants deleted, before their tags are purged, so a miss
 * that lands after the purge cannot cache a fresh variant for a year. A tenant
 * is its env-scoped prefix `<base>/<slug>`: slugs repeat across envs.
 * @param {Record<string, any>} env
 * @param {{ keys?: string[], tenants?: string[] }} what - object keys; tenant prefixes
 */
export async function markDeleted(env, { keys = [], tenants = [] }) {
	const at = String(Date.now());
	const options = { expirationTtl: DELETED_TTL_SECONDS };
	await Promise.all([
		...keys.map((key) => env.DELETED.put(`key:${key}`, at, options)),
		...tenants.map((prefix) => env.DELETED.put(`tenant:${prefix}`, at, options)),
	]);
}

/**
 * Whether a read names a deleted object: its key is marked, or its tenant was
 * purged before its media id was minted. The mint time decides because a
 * purged tenant's slug can be taken again (fixtures are recreated right after
 * a purge), and the new tenant's media must serve.
 * @param {string} pathname - `/<key>`
 * @param {Record<string, any>} env
 * @returns {Promise<boolean>}
 */
export async function isDeleted(pathname, env) {
	const key = pathname.replace(/^\/+/, '');
	const segments = key.split('/');
	const tenant = segments.length >= 4 ? `${segments[0]}/${segments[1]}` : null;
	try {
		const [object, tenantDeletedAt] = await Promise.all([
			env.DELETED.get(`key:${key}`),
			tenant ? env.DELETED.get(`tenant:${tenant}`) : null,
		]);
		if (object !== null) return true;
		if (tenantDeletedAt === null) return false;
		const minted = typeIdTime(segments[2]);
		return minted === null || minted <= Number(tenantDeletedAt);
	} catch (err) {
		// Open, not closed: a KV outage must not take down every uncached image.
		console.error(`deleted check failed for ${key}:`, err);
		return false;
	}
}

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';

/**
 * The mint time of a prefixed TypeID (`media_01m3…`): its first ten suffix
 * characters are the UUIDv7's 48-bit millisecond timestamp.
 * @param {string} id
 * @returns {number | null} epoch ms; null when `id` is not a TypeID
 */
export function typeIdTime(id) {
	const suffix = id?.split('_').pop();
	if (!suffix || !/^[0-7][0-9a-hjkmnp-tv-z]{25}$/.test(suffix)) return null;
	let ms = 0;
	for (const char of suffix.slice(0, 10)) ms = ms * 32 + CROCKFORD.indexOf(char);
	return ms;
}

/**
 * Bump when the transform's output for an unchanged URL changes (option
 * mapping, negotiation, headers): the cache outlives deploys, so this is what
 * retires every entry the previous behaviour wrote, atomically with the deploy.
 */
const CACHE_KEY_VERSION = 'v1';

/**
 * The format a request will be answered in, decided as `handleFetchAndTransform`
 * decides: an SVG is served as is, an explicit `format` other than `auto` wins,
 * else `Accept` picks AVIF, then WebP, then JPEG.
 * @param {Request} request
 * @returns {'avif'|'webp'|'jpeg'|'asked'|'svg'}
 */
export function negotiatedFormat(request) {
	const url = new URL(request.url);
	if (url.pathname.endsWith('.svg')) return 'svg';
	const asked = url.searchParams.get('format');
	if (asked && asked !== 'auto') return 'asked';
	const accept = request.headers.get('Accept') || '';
	if (/image\/avif/.test(accept)) return 'avif';
	if (/image\/webp/.test(accept)) return 'webp';
	return 'jpeg';
}

/**
 * The `Transform` cache key: the key version, the negotiated format, then the
 * path and query as requested. The format leads the path so no query string
 * can spell another format's entry.
 * @param {Request} request
 * @returns {string}
 */
export function transformCacheKey(request) {
	const url = new URL(request.url);
	return `/${CACHE_KEY_VERSION}/${negotiatedFormat(request)}${url.pathname}${url.search}`;
}

/**
 * An image read: only `Accept` crosses into the cached entrypoint, and a
 * negotiated answer is marked as varying by it on the way out (the cache
 * never sees that `Vary`; the key already carries the format).
 * @param {Request} request
 * @param {ExecutionContext} ctx
 * @returns {Promise<Response>}
 */
async function serveImage(request, ctx) {
	const accept = request.headers.get('Accept');
	const upstream = new Request(request.url, { method: request.method, headers: accept ? { Accept: accept } : {} });
	const format = negotiatedFormat(request);
	const response = await ctx.exports.Transform.fetch(upstream, { cf: { cacheKey: transformCacheKey(request) } });
	const headers = new Headers(response.headers);
	// Every image here is public, so a page's script may read what it can
	// already display: a canvas, a size audit, a download. No credentials ride
	// these requests, so the wildcard is the right form.
	headers.set('Access-Control-Allow-Origin', '*');
	if (response.ok && format !== 'asked' && format !== 'svg') headers.set('Vary', 'Accept');
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** The host whose keys all live in the production bucket, whatever their shape. */
const PRODUCTION_ONLY_HOST = 'img.arroweffect.com';

/** A first key segment naming a non-production tier: `afx-site-staging`, `jhb-site-preview`, … */
const NON_PRODUCTION_SEGMENT = /-(staging|preview|sandbox)$/;

/**
 * Whether a key belongs in `media-staging`. Every non-production tier of the
 * CMS writes there under `<brand>-<tier>/…`; production writes `media` under
 * `<brand>/…`, and so does everything else this worker serves.
 * @param {string} key - Object key, with or without a leading slash
 * @param {string} [host] - Request hostname
 * @returns {boolean}
 */
export function isStagingKey(key, host) {
	if (host === PRODUCTION_ONLY_HOST) return false;
	const segments = key.replace(/^\/+/, '').split('/');
	return segments.length > 1 && NON_PRODUCTION_SEGMENT.test(segments[0]);
}

/**
 * The bucket and origin that hold `key`.
 * @param {string} key
 * @param {Request} request
 * @param {Record<string, any>} env
 * @returns {{ bucket: R2Bucket, origin: string }}
 */
export function mediaLocation(key, request, env) {
	const host = new URL(request.url).hostname;
	// cf.image only transforms an origin on the requesting zone; a cross-zone
	// origin comes back untransformed, with no error. So each host reads its
	// bucket through a custom domain on its own zone.
	if (host === PRODUCTION_ONLY_HOST) return { bucket: env.MEDIA_BUCKET, origin: env.ARROWEFFECT_ORIGIN };
	return isStagingKey(key, host)
		? { bucket: env.MEDIA_STAGING_BUCKET, origin: env.CDN_STAGING_ORIGIN }
		: { bucket: env.MEDIA_BUCKET, origin: env.CDN_ORIGIN };
}

/**
 * Validates that a storage path is safe to use with R2.
 * Rejects empty paths, directory traversal, leading slashes, and control characters.
 * @param {string} path
 * @returns {boolean}
 */
export function isValidPath(path) {
	if (!path || typeof path !== 'string') return false;
	if (path.startsWith('/') || path.startsWith('.')) return false;
	if (path.includes('..') || path.includes('//')) return false;
	if (/[\x00-\x1f]/.test(path)) return false;
	return true;
}

/**
 * Checks if the request is authorized via Bearer token.
 * @param {Request} request - Incoming HTTP request
 * @param {Record<string, any>} env - Worker environment bindings
 * @returns {boolean} True if authorized
 */
function isAuthorized(request, env) {
	const authHeader = request.headers.get('Authorization');
	if (!authHeader || !authHeader.startsWith('Bearer ')) {
		return false;
	}
	const token = authHeader.substring(7);
	return token === env.IMG_API_SECRET;
}

/**
 * Handles file upload to R2 storage.
 * @param {Request} request - Incoming HTTP request
 * @param {Record<string, any>} env - Worker environment bindings
 * @returns {Promise<Response>}
 */
async function handleUpload(request, env) {
	if (!isAuthorized(request, env)) {
		return new Response('Unauthorized', { status: 401 });
	}

	if (request.headers.get('Content-Type') !== 'application/json') {
		return new Response('Content-Type must be application/json', { status: 400 });
	}

	let body;
	try {
		body = await request.json();
	} catch {
		return new Response('Invalid JSON body', { status: 400 });
	}

	const { path, contentType, fileBase64 } = body;

	if (!path || !contentType || !fileBase64) {
		return new Response('Missing `path`, `contentType`, or `fileBase64` in body', { status: 400 });
	}

	if (!isValidPath(path)) {
		return new Response('Invalid `path`', { status: 400 });
	}

	const buffer = Uint8Array.from(atob(fileBase64), (c) => c.charCodeAt(0));

	await mediaLocation(path, request, env).bucket.put(path, buffer, {
		httpMetadata: {
			contentType,
			cacheControl: 'public, max-age=31536000',
		},
	});

	return new Response(`Uploaded ${path} successfully`, { status: 201 });
}

/**
 * Handles deletion of a file from R2 storage.
 * @param {Request} request - Incoming HTTP request
 * @param {Record<string, any>} env - Worker environment bindings
 * @returns {Promise<Response>}
 */
async function handleDelete(request, env, ctx) {
	if (!isAuthorized(request, env)) {
		return new Response(
			JSON.stringify({
				success: false,
				error: 'Unauthorized',
			}),
			{ status: 401, headers: { 'Content-Type': 'application/json' } },
		);
	}

	let body;
	try {
		body = await request.json();
	} catch {
		return new Response(
			JSON.stringify({
				success: false,
				error: 'Invalid JSON body',
			}),
			{ status: 400, headers: { 'Content-Type': 'application/json' } },
		);
	}

	const { path } = body;

	if (!path) {
		return new Response(
			JSON.stringify({
				success: false,
				error: 'Missing `path` field in body',
			}),
			{ status: 400, headers: { 'Content-Type': 'application/json' } },
		);
	}

	if (!isValidPath(path)) {
		return new Response(
			JSON.stringify({
				success: false,
				error: 'Invalid `path`',
			}),
			{ status: 400, headers: { 'Content-Type': 'application/json' } },
		);
	}

	const { bucket } = mediaLocation(path, request, env);
	const object = await bucket.head(path);
	if (!object) {
		return new Response(
			JSON.stringify({
				success: false,
				error: `File "${path}" not found in bucket`,
			}),
			{ status: 404, headers: { 'Content-Type': 'application/json' } },
		);
	}

	await bucket.delete(path);
	// The cache outlives the object: without this its variants serve for a year.
	await markDeleted(env, { keys: [path] });
	const purge = await ctx.exports.Transform.purge({ keys: [path] });

	return new Response(
		JSON.stringify({
			success: true,
			deleted: path,
			purged: purge.success,
			...(purge.success ? {} : { purgeErrors: purge.errors }),
		}),
		{ status: 200, headers: { 'Content-Type': 'application/json' } },
	);
}

/** A tag purge takes at most 30 tags per call. */
const MAX_PURGE_TAGS = 30;

/**
 * Drops the cached variants of the given image URLs (`url` or `urls`), or of
 * whole tenants (`tenants`), for objects removed behind this worker's back.
 * Zone purges never reach a Worker's cache, so this is the only way in.
 * @param {Request} request - Incoming HTTP request
 * @param {Record<string, any>} env - Worker environment bindings
 * @param {ExecutionContext} ctx
 * @returns {Promise<Response>}
 */
async function handlePurge(request, env, ctx) {
	if (!isAuthorized(request, env)) {
		return new Response('Unauthorized', { status: 401 });
	}

	let body;
	try {
		body = await request.json();
	} catch {
		return new Response('Invalid JSON body', { status: 400 });
	}

	const json = (payload, status) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });

	const urls = body.urls ?? (body.url ? [body.url] : []);
	const tenants = body.tenants ?? [];
	if (!Array.isArray(urls) || !Array.isArray(tenants) || urls.length + tenants.length === 0) {
		return new Response('Missing `url`, `urls` or `tenants` in body', { status: 400 });
	}
	if (urls.length + tenants.length > MAX_PURGE_TAGS) {
		return new Response(`At most ${MAX_PURGE_TAGS} urls and tenants per request`, { status: 400 });
	}
	if (tenants.some((slug) => typeof slug !== 'string' || !/^[a-z0-9-]+$/.test(slug))) {
		return new Response('Invalid `tenants` entry', { status: 400 });
	}
	const keys = [];
	for (const target of urls) {
		try {
			keys.push(new URL(target).pathname.replace(/^\/+/, ''));
		} catch {
			return new Response('Invalid `url` field', { status: 400 });
		}
	}

	const result = await ctx.exports.Transform.purge({ keys, tenants });
	return json({ ...result, purged: keys, purgedTenants: tenants }, result.success ? 200 : 502);
}

/** A tenant as the CMS names it here: `<env base>/<slug>`. */
const TENANT_PREFIX = /^[a-z0-9-]+\/[a-z0-9-]+$/;

/**
 * Objects (`keys`) and tenants (`tenants`, as `<base>/<slug>`) the CMS removed
 * from the bucket itself: marks each deleted, then purges its tags. Unlike
 * `/purge`, which only empties the cache, a marked object stays unservable,
 * so this is for deletes only. Safe to repeat.
 * @param {Request} request
 * @param {Record<string, any>} env
 * @param {ExecutionContext} ctx
 * @returns {Promise<Response>}
 */
async function handleTombstone(request, env, ctx) {
	if (!isAuthorized(request, env)) {
		return new Response('Unauthorized', { status: 401 });
	}

	let body;
	try {
		body = await request.json();
	} catch {
		return new Response('Invalid JSON body', { status: 400 });
	}

	const keys = body.keys ?? [];
	const tenants = body.tenants ?? [];
	if (!Array.isArray(keys) || !Array.isArray(tenants) || keys.length + tenants.length === 0) {
		return new Response('Missing `keys` or `tenants` in body', { status: 400 });
	}
	if (keys.length + tenants.length > MAX_PURGE_TAGS) {
		return new Response(`At most ${MAX_PURGE_TAGS} keys and tenants per request`, { status: 400 });
	}
	if (!keys.every(isValidPath)) {
		return new Response('Invalid `keys` entry', { status: 400 });
	}
	if (tenants.some((prefix) => typeof prefix !== 'string' || !TENANT_PREFIX.test(prefix))) {
		return new Response('Invalid `tenants` entry: expected `<base>/<slug>`', { status: 400 });
	}

	await markDeleted(env, { keys, tenants });
	const result = await ctx.exports.Transform.purge({ keys, tenants: tenants.map((prefix) => prefix.split('/')[1]) });
	return new Response(JSON.stringify({ ...result, tombstoned: keys, tombstonedTenants: tenants }), {
		status: result.success ? 200 : 502,
		headers: { 'Content-Type': 'application/json' },
	});
}

/**
 * Handles serving and transforming images using Cloudflare Images API.
 * @param {Request} request - Incoming HTTP request
 * @param {Record<string, any>} env - Worker environment bindings
 * @returns {Promise<Response>}
 */
async function handleFetchAndTransform(request, env) {
	const url = new URL(request.url);
	const path = url.pathname;
	const searchParams = url.searchParams;
	const imageURL = `${mediaLocation(path, request, env).origin}${path}`;
	const isSvg = path.endsWith('.svg');

	// Step 1: Fetch the image (SVG = plain fetch, everything else = cf.image with fallback)
	let response;
	// Why the bytes are the original rather than a transform; null when transformed.
	let untransformed = null;

	if (isSvg) {
		try {
			response = await fetch(imageURL, { headers: { Accept: 'image/svg+xml' } });
		} catch (err) {
			console.error(`SVG fetch threw for ${imageURL}:`, err);
			response = null;
		}
	} else {
		const accept = request.headers.get('Accept') || '';
		const allowedParams = ['width', 'height', 'quality', 'fit', 'dpr', 'gravity', 'crop', 'pad', 'background', 'draw', 'rotate', 'trim'];
		const imageOptions = {};

		for (const [key, value] of searchParams.entries()) {
			if (allowedParams.includes(key)) {
				const num = Number(value);
				imageOptions[key] = isNaN(num) ? value : num;
			}
		}

		const urlFormat = searchParams.get('format');

		if (urlFormat && urlFormat !== 'auto') {
			// Explicit format requested (e.g., 'png', 'webp', 'avif') — use as-is
			imageOptions.format = urlFormat;
		} else {
			// No format or format=auto — content-negotiate from Accept header
			if (/image\/avif/.test(accept)) {
				imageOptions.format = 'avif';
			} else if (/image\/webp/.test(accept)) {
				imageOptions.format = 'webp';
			} else {
				imageOptions.format = 'jpeg';
			}
		}

		const imageRequest = new Request(imageURL, {
			headers: {
				'User-Agent': 'Cloudflare-Worker',
				Accept: accept || 'image/*',
			},
		});

		try {
			response = await fetch(imageRequest, { cf: { image: imageOptions } });
		} catch (err) {
			console.error(`cf.image fetch threw for ${imageURL}:`, err);
			untransformed = `threw ${err?.message ?? err}`;
			response = null;
		}

		// A transform answers 2xx with `cf-resized: internal=…`. A 2xx without it is
		// the original passed through (transforms disabled on the zone, or an origin
		// off the zone), which used to be cached for a year and hid the gap for months.
		if (response?.ok) {
			const resized = response.headers.get('cf-resized') || '';
			if (!resized.startsWith('internal=')) untransformed = resized || 'no cf-resized header';
		}

		// Fallback: a non-OK, non-404 transform (quota err=9422, bad parameters, 5xx) serves the original from the origin
		if (!response || (!response.ok && response.status !== 404)) {
			if (response) {
				untransformed = `${response.status} ${response.headers.get('cf-resized') || ''}`.trim();
				console.error(`cf.image returned ${untransformed} for ${imageURL}, falling back to origin`);
			}
			try {
				response = await fetch(imageURL, {
					headers: { 'User-Agent': 'Cloudflare-Worker', Accept: accept || 'image/*' },
				});
			} catch (err) {
				console.error(`Origin fallback fetch threw for ${imageURL}:`, err);
				response = null;
			}
		}
	}

	// Step 2: Shared error handling
	if (!response) {
		console.log(
			JSON.stringify({
				level: 'error',
				type: 'image_fetch_failed',
				path: path,
				origin: imageURL,
				status: 502,
				colo: request.cf?.colo,
				country: request.cf?.country,
				city: request.cf?.city,
				ray: request.headers.get('cf-ray'),
			}),
		);
		return new Response('Image fetch failed', {
			status: 502,
			headers: { 'Cache-Control': 'no-store' },
		});
	}

	if (response.status === 404) {
		console.log(
			JSON.stringify({
				level: 'error',
				type: 'image_not_found',
				path: path,
				origin: imageURL,
				status: 404,
				colo: request.cf?.colo,
				country: request.cf?.country,
				city: request.cf?.city,
				ray: request.headers.get('cf-ray'),
			}),
		);
		return new Response('Image not found', {
			status: 404,
			headers: { 'Cache-Control': 'no-store' },
		});
	}

	if (!response.ok) {
		console.log(
			JSON.stringify({
				level: 'error',
				type: 'image_fetch_failed',
				path: path,
				origin: imageURL,
				status: response.status,
				colo: request.cf?.colo,
				country: request.cf?.country,
				city: request.cf?.city,
				ray: request.headers.get('cf-ray'),
			}),
		);
		return new Response('Image fetch failed', {
			status: response.status,
			headers: { 'Cache-Control': 'no-store' },
		});
	}

	// Step 3: Success — cache and return
	const headers = new Headers(response.headers);
	if (untransformed) {
		// Short-lived so a fixed zone or quota takes effect within a minute, and
		// named on the response so a probe sees the cause.
		const reason = untransformed.replace(/[\r\n]+/g, ' ').slice(0, 200);
		console.log(
			JSON.stringify({
				level: 'warn',
				type: 'image_untransformed',
				path: path,
				origin: imageURL,
				reason,
				status: response.status,
				colo: request.cf?.colo,
				ray: request.headers.get('cf-ray'),
			}),
		);
		headers.set('Cache-Control', 'public, max-age=60');
		headers.set('X-Img-Untransformed', reason);
	} else {
		// A key is written once and never reused, so its bytes are fixed for life.
		headers.set('Cache-Control', 'public, max-age=31536000, immutable');
		headers.set('Cache-Tag', cacheTagsFor(path).join(','));
	}
	if (isSvg) {
		headers.set('Content-Type', 'image/svg+xml');
	}

	return new Response(response.body, {
		headers,
		status: response.status,
		statusText: response.statusText,
	});
}
