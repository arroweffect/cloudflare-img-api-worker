export default {
	/**
	 * Entry point for the Worker. Routes requests to appropriate handler.
	 * @param {Request} request - Incoming HTTP request
	 * @param {Record<string, any>} env - Worker environment bindings
	 * @returns {Promise<Response>}
	 */
	async fetch(request, env) {
		const url = new URL(request.url);
		const method = request.method;
		const pathname = url.pathname;

		if (pathname === '/upload' && method === 'POST') {
			return handleUpload(request, env);
		} else if (pathname === '/purge' && method === 'POST') {
			return handlePurge(request, env);
		} else if (pathname === '/delete' && method === 'POST') {
			return handleDelete(request, env);
		} else {
			return handleFetchAndTransform(request, env);
		}
	},
};

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
async function handleDelete(request, env) {
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

	return new Response(
		JSON.stringify({
			success: true,
			deleted: path,
		}),
		{ status: 200, headers: { 'Content-Type': 'application/json' } },
	);
}

/**
 * Handles purging Cloudflare cache for a specific file URL.
 * @param {Request} request - Incoming HTTP request
 * @param {Record<string, any>} env - Worker environment bindings
 * @returns {Promise<Response>}
 */
async function handlePurge(request, env) {
	if (!isAuthorized(request, env)) {
		return new Response('Unauthorized', { status: 401 });
	}

	let body;
	try {
		body = await request.json();
	} catch {
		return new Response('Invalid JSON body', { status: 400 });
	}

	const { url: targetUrlStr } = body;

	if (!targetUrlStr) {
		return new Response('Missing `url` field in body', { status: 400 });
	}

	let purgeTarget;
	try {
		const targetUrl = new URL(targetUrlStr);
		purgeTarget = targetUrl.toString();
	} catch {
		return new Response('Invalid `url` field', { status: 400 });
	}

	const purgeRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${env.ZONE_ID}/purge_cache`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${env.CF_PURGE_TOKEN}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			files: [purgeTarget],
		}),
	});

	const data = await purgeRes.json();

	if (!purgeRes.ok || !data.success) {
		console.error('Purge error:', data.errors);
		return new Response(`Failed to purge: ${JSON.stringify(data.errors)}`, { status: 500 });
	}

	return new Response(
		JSON.stringify({
			success: true,
			purged: purgeTarget,
			cloudflare: data,
		}),
		{
			status: 200,
			headers: { 'Content-Type': 'application/json' },
		},
	);
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
		headers.set('Cache-Control', 'public, max-age=31536000, stale-while-revalidate=86400');
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
