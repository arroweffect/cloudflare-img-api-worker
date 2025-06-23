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
			return handleFetchAndTransform(request);
		}
	},
};

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
	return token === env.IMAGE_API_SECRET;
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

	const buffer = Uint8Array.from(atob(fileBase64), (c) => c.charCodeAt(0));

	await env.MEDIA_BUCKET.put(path, buffer, {
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
			{ status: 401, headers: { 'Content-Type': 'application/json' } }
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
			{ status: 400, headers: { 'Content-Type': 'application/json' } }
		);
	}

	const { path } = body;

	if (!path) {
		return new Response(
			JSON.stringify({
				success: false,
				error: 'Missing `path` field in body',
			}),
			{ status: 400, headers: { 'Content-Type': 'application/json' } }
		);
	}

	const object = await env.MEDIA_BUCKET.get(path);
	if (!object) {
		return new Response(
			JSON.stringify({
				success: false,
				error: `File "${path}" not found in bucket`,
			}),
			{ status: 404, headers: { 'Content-Type': 'application/json' } }
		);
	}

	await env.MEDIA_BUCKET.delete(path);

	return new Response(
		JSON.stringify({
			success: true,
			deleted: path,
		}),
		{ status: 200, headers: { 'Content-Type': 'application/json' } }
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
			Authorization: `Bearer ${env.CF_API_TOKEN}`,
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
		}
	);
}

/**
 * Handles serving and transforming images using Cloudflare Images API.
 * @param {Request} request - Incoming HTTP request
 * @returns {Promise<Response>}
 */
async function handleFetchAndTransform(request) {
	const url = new URL(request.url);
	const path = url.pathname;
	const searchParams = url.searchParams;

	const imageURL = `https://media.arroweffect.com${path}`;

	const allowedParams = ['width', 'height', 'quality', 'fit', 'dpr', 'gravity', 'crop', 'pad', 'background', 'draw', 'rotate', 'trim'];
	const imageOptions = {};

	for (const [key, value] of searchParams.entries()) {
		if (allowedParams.includes(key)) {
			const num = Number(value);
			imageOptions[key] = isNaN(num) ? value : num;
		}
	}

	const accept = request.headers.get('Accept') || '';
	if (/image\/avif/.test(accept)) {
		imageOptions.format = 'avif';
	} else if (/image\/webp/.test(accept)) {
		imageOptions.format = 'webp';
	} else if (/image\//.test(accept)) {
		imageOptions.format = 'jpeg';
	} else {
		imageOptions.format = 'jpeg';
	}

	const options = { cf: { image: imageOptions } };

	const imageRequest = new Request(imageURL, {
		headers: {
			'User-Agent': 'Cloudflare-Worker',
			Accept: accept || 'image/*',
		},
	});

	const response = await fetch(imageRequest, options);

	if (response.status === 404) {
		return new Response('Image not found', {
			status: 404,
			headers: {
				'Cache-Control': 'public, max-age=60',
			},
		});
	}

	const headers = new Headers(response.headers);
	headers.set('Cache-Control', 'public, max-age=31536000, stale-while-revalidate=86400');

	return new Response(response.body, {
		headers,
		status: response.status,
		statusText: response.statusText,
	});
}
