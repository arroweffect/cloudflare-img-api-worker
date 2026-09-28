import { env, createExecutionContext, fetchMock, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, afterEach, beforeAll, describe, it, expect } from 'vitest';
import worker, { isStagingKey, isValidPath, negotiatedFormat, transformCacheKey, cacheTagsFor } from '../src';

// Helper to call worker.fetch with a context
async function workerFetch(request, workerEnv = env) {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, workerEnv, ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

describe('isValidPath', () => {
	it.each([
		['images/photo.jpg'],
		['uploads/2024/file.png'],
		['a.txt'],
	])('accepts valid path: %s', (path) => {
		expect(isValidPath(path)).toBe(true);
	});

	it.each([
		[null, 'null'],
		[undefined, 'undefined'],
		['', 'empty string'],
		[123, 'number'],
	])('rejects falsy/non-string: %s (%s)', (path) => {
		expect(isValidPath(path)).toBe(false);
	});

	it.each([
		['/leading-slash.jpg'],
		['.hidden'],
		['./relative'],
	])('rejects leading / or .: %s', (path) => {
		expect(isValidPath(path)).toBe(false);
	});

	it.each([
		['foo/../bar'],
		['../escape'],
		['a//b'],
	])('rejects traversal and double slashes: %s', (path) => {
		expect(isValidPath(path)).toBe(false);
	});

	it('rejects control characters', () => {
		expect(isValidPath('foo\x00bar')).toBe(false);
		expect(isValidPath('foo\nbar')).toBe(false);
		expect(isValidPath('foo\tbar')).toBe(false);
	});
});

describe('routing', () => {
	it('routes POST /upload to upload handler (requires auth)', async () => {
		const request = new Request('http://example.com/upload', { method: 'POST' });
		const response = await workerFetch(request);
		expect(response.status).toBe(401);
	});

	it('routes POST /delete to delete handler (requires auth)', async () => {
		const request = new Request('http://example.com/delete', { method: 'POST' });
		const response = await workerFetch(request);
		expect(response.status).toBe(401);
	});

	it('routes POST /purge to purge handler (requires auth)', async () => {
		const request = new Request('http://example.com/purge', { method: 'POST' });
		const response = await workerFetch(request);
		expect(response.status).toBe(401);
	});

	it('routes GET on admin paths to image handler, not admin handler', async () => {
		const request = new Request('http://example.com/upload', { method: 'GET' });
		const response = await workerFetch(request);
		// Falls through to handleFetchAndTransform, not the upload handler
		// So we should NOT get 401
		expect(response.status).not.toBe(401);
	});
});

describe('auth', () => {
	it('rejects requests with no Authorization header', async () => {
		const request = new Request('http://example.com/upload', {
			method: 'POST',
		});
		const response = await workerFetch(request);
		expect(response.status).toBe(401);
	});

	it('rejects requests with wrong token', async () => {
		const request = new Request('http://example.com/upload', {
			method: 'POST',
			headers: { Authorization: 'Bearer wrong-token' },
		});
		const response = await workerFetch(request);
		expect(response.status).toBe(401);
	});

	it('rejects requests with malformed Authorization header', async () => {
		const request = new Request('http://example.com/upload', {
			method: 'POST',
			headers: { Authorization: 'Basic abc123' },
		});
		const response = await workerFetch(request);
		expect(response.status).toBe(401);
	});
});

describe('upload validation', () => {
	function authHeaders() {
		return {
			Authorization: `Bearer ${env.IMG_API_SECRET}`,
			'Content-Type': 'application/json',
		};
	}

	it('rejects invalid path on upload', async () => {
		const request = new Request('http://example.com/upload', {
			method: 'POST',
			headers: authHeaders(),
			body: JSON.stringify({
				path: '../escape.jpg',
				contentType: 'image/jpeg',
				fileBase64: btoa('fake'),
			}),
		});
		const response = await workerFetch(request);
		expect(response.status).toBe(400);
		expect(await response.text()).toContain('Invalid');
	});

	it('rejects missing fields on upload', async () => {
		const request = new Request('http://example.com/upload', {
			method: 'POST',
			headers: authHeaders(),
			body: JSON.stringify({ path: 'test.jpg' }),
		});
		const response = await workerFetch(request);
		expect(response.status).toBe(400);
	});
});

describe('delete validation', () => {
	function authHeaders() {
		return {
			Authorization: `Bearer ${env.IMG_API_SECRET}`,
			'Content-Type': 'application/json',
		};
	}

	it('rejects invalid path on delete', async () => {
		const request = new Request('http://example.com/delete', {
			method: 'POST',
			headers: authHeaders(),
			body: JSON.stringify({ path: '/leading-slash.jpg' }),
		});
		const response = await workerFetch(request);
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.success).toBe(false);
		expect(body.error).toContain('Invalid');
	});

	it('returns 404 for non-existent file on delete', async () => {
		const request = new Request('http://example.com/delete', {
			method: 'POST',
			headers: authHeaders(),
			body: JSON.stringify({ path: 'does-not-exist.jpg' }),
		});
		const response = await workerFetch(request);
		expect(response.status).toBe(404);
	});
});

describe('cache headers', () => {
	it('returns no-store on image 404', async () => {
		const request = new Request('http://example.com/nonexistent.jpg');
		const response = await workerFetch(request);
		expect(response.headers.get('Cache-Control')).toBe('no-store');
	});

	it('returns no-store on SVG 404', async () => {
		const request = new Request('http://example.com/nonexistent.svg');
		const response = await workerFetch(request);
		expect(response.headers.get('Cache-Control')).toBe('no-store');
	});
});

describe('bucket routing by tier', () => {
	it.each([
		['afx-site-staging/acme/media_01j8/logo.png', 'afx staging'],
		['afx-site-preview/acme/media_01j8/logo.png', 'afx preview and local dev'],
		['afx-site-sandbox/acme/logo.png', 'afx sandbox'],
		['jhb-site-staging/acme/logo.png', 'jhb staging'],
		['jhb-site-preview/acme/logo.png', 'jhb preview'],
		['/afx-site-staging/acme/logo.png', 'a request path'],
	])('reads %s from media-staging (%s)', (key) => {
		expect(isStagingKey(key, 'img.afxengine.com')).toBe(true);
	});

	it.each([
		['afx-site/acme/media_01j8/logo.png', 'afx production'],
		['jhb-site/acme/logo.png', 'jhb production'],
		['clients/example/cover.jpg', 'a key outside the CMS'],
		['acme/afx-site-staging/logo.png', 'a tier name past the first segment'],
		['afx-site-staging', 'a bare object named like a tier'],
		['afx-site-stagingx/acme/logo.png', 'a segment that only starts like a tier'],
	])('reads %s from media (%s)', (key) => {
		expect(isStagingKey(key, 'img.afxengine.com')).toBe(false);
	});

	it('reads every img.arroweffect.com key from media, whatever its shape', () => {
		expect(isStagingKey('clients/example/cover.jpg', 'img.arroweffect.com')).toBe(false);
		expect(isStagingKey('afx-site-staging/acme/logo.png', 'img.arroweffect.com')).toBe(false);
	});
});

describe('upload and delete by tier', () => {
	const headers = () => ({ Authorization: `Bearer ${env.IMG_API_SECRET}`, 'Content-Type': 'application/json' });
	const upload = (host, path) =>
		workerFetch(
			new Request(`https://${host}/upload`, {
				method: 'POST',
				headers: headers(),
				body: JSON.stringify({ path, contentType: 'image/png', fileBase64: btoa('png') }),
			}),
		);
	const remove = (host, path) =>
		workerFetch(new Request(`https://${host}/delete`, { method: 'POST', headers: headers(), body: JSON.stringify({ path }) }));

	it('writes a staging key to media-staging only', async () => {
		const path = 'afx-site-staging/acme/media_1/logo.png';
		expect((await upload('img.afxengine.com', path)).status).toBe(201);
		expect(await env.MEDIA_STAGING_BUCKET.head(path)).not.toBeNull();
		expect(await env.MEDIA_BUCKET.head(path)).toBeNull();
	});

	it('writes a production key to media only', async () => {
		const path = 'afx-site/acme/media_2/logo.png';
		expect((await upload('img.afxengine.com', path)).status).toBe(201);
		expect(await env.MEDIA_BUCKET.head(path)).not.toBeNull();
		expect(await env.MEDIA_STAGING_BUCKET.head(path)).toBeNull();
	});

	it('writes every img.arroweffect.com upload to media', async () => {
		const path = 'afx-site-staging/client/cover.jpg';
		expect((await upload('img.arroweffect.com', path)).status).toBe(201);
		expect(await env.MEDIA_BUCKET.head(path)).not.toBeNull();
		expect(await env.MEDIA_STAGING_BUCKET.head(path)).toBeNull();
	});

	it('deletes a staging key from media-staging, never touches media, and purges its variants', async () => {
		const path = 'afx-site-preview/acme/media_3/logo.png';
		await env.MEDIA_STAGING_BUCKET.put(path, 'staging');
		await env.MEDIA_BUCKET.put(path, 'production');
		const response = await remove('img.afxengine.com', path);
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.deleted).toBe(path);
		expect(typeof body.purged).toBe('boolean');
		expect(await env.MEDIA_STAGING_BUCKET.head(path)).toBeNull();
		expect(await env.MEDIA_BUCKET.head(path)).not.toBeNull();
	});

	it('answers 404 for a staging key that exists only in media', async () => {
		const path = 'afx-site-staging/acme/media_4/logo.png';
		await env.MEDIA_BUCKET.put(path, 'production');
		expect((await remove('img.afxengine.com', path)).status).toBe(404);
	});
});

describe('serving by tier', () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});
	afterEach(() => fetchMock.assertNoPendingInterceptors());
	afterAll(() => fetchMock.deactivate());

	const origin = (base, path) =>
		fetchMock
			.get(base)
			.intercept({ path })
			.reply(200, 'bytes', { headers: { 'Content-Type': 'image/svg+xml' } });

	it('fetches a staging key from the media-staging origin', async () => {
		origin(env.CDN_STAGING_ORIGIN, '/afx-site-staging/acme/logo.svg');
		const response = await workerFetch(new Request('https://img.afxengine.com/afx-site-staging/acme/logo.svg'));
		expect(response.status).toBe(200);
	});

	it('fetches a production key from the media origin', async () => {
		origin(env.CDN_ORIGIN, '/afx-site/acme/logo.svg');
		const response = await workerFetch(new Request('https://img.afxengine.com/afx-site/acme/logo.svg'));
		expect(response.status).toBe(200);
	});

	it('fetches every img.arroweffect.com key from the arroweffect.com origin', async () => {
		origin(env.ARROWEFFECT_ORIGIN, '/clients/example/cover.svg');
		const response = await workerFetch(new Request('https://img.arroweffect.com/clients/example/cover.svg'));
		expect(response.status).toBe(200);
	});

	it('transforms an img.arroweffect.com raster from its own zone', async () => {
		origin(env.ARROWEFFECT_ORIGIN, '/web/collage/photo.jpg');
		const response = await workerFetch(new Request('https://img.arroweffect.com/web/collage/photo.jpg?width=60'));
		expect(response.status).toBe(200);
	});

	it('keeps a staging-shaped key on img.arroweffect.com on its own origin', async () => {
		origin(env.ARROWEFFECT_ORIGIN, '/afx-site-staging/acme/logo.svg');
		const response = await workerFetch(new Request('https://img.arroweffect.com/afx-site-staging/acme/logo.svg'));
		expect(response.status).toBe(200);
	});

	it('fetches a raster from the tier origin through the transform', async () => {
		origin(env.CDN_STAGING_ORIGIN, '/jhb-site-preview/acme/photo.jpg');
		const response = await workerFetch(new Request('https://img.afxengine.com/jhb-site-preview/acme/photo.jpg?width=200'));
		expect(response.status).toBe(200);
	});
});

describe('untransformed originals', () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});
	afterEach(() => fetchMock.assertNoPendingInterceptors());
	afterAll(() => fetchMock.deactivate());

	const path = '/afx-site/acme/media_1/photo.jpg';
	const url = `https://img.afxengine.com${path}?width=64`;
	const reply = (status, headers = {}) =>
		fetchMock
			.get(env.CDN_ORIGIN)
			.intercept({ path })
			.reply(status, 'bytes', { headers: { 'Content-Type': 'image/jpeg', ...headers } });

	it('caches a transform for a year, immutable, tagged by tenant', async () => {
		reply(200, { 'cf-resized': 'internal=ok/m q=0 n=346+0' });
		const response = await workerFetch(new Request(url));
		expect(response.status).toBe(200);
		expect(response.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
		expect(response.headers.get('Cache-Tag')).toBe('key:afx-site/acme/media_1/photo.jpg,tenant:acme');
		expect(response.headers.get('X-Img-Untransformed')).toBeNull();
	});

	it('caches a passed-through original for a minute and names the cause', async () => {
		reply(200);
		const response = await workerFetch(new Request(url));
		expect(response.status).toBe(200);
		expect(response.headers.get('Cache-Control')).toBe('public, max-age=60');
		expect(response.headers.get('X-Img-Untransformed')).toBe('no cf-resized header');
	});

	it('names the transform error when the origin fallback serves the original', async () => {
		reply(429, { 'cf-resized': 'err=9422' });
		reply(200);
		const response = await workerFetch(new Request(url));
		expect(response.status).toBe(200);
		expect(response.headers.get('Cache-Control')).toBe('public, max-age=60');
		expect(response.headers.get('X-Img-Untransformed')).toBe('429 err=9422');
	});

	it('never caches when the origin fallback fails too', async () => {
		reply(500, { 'cf-resized': 'err=9520' });
		reply(502);
		const response = await workerFetch(new Request(url));
		expect(response.status).toBe(502);
		expect(response.headers.get('Cache-Control')).toBe('no-store');
	});
});

describe('transform cache key', () => {
	const req = (url, accept) => new Request(url, { headers: accept ? { Accept: accept } : {} });
	const avif = 'image/avif,image/webp,image/*,*/*;q=0.8';

	it.each([
		['https://img.afxengine.com/a/b/c.jpg?width=64', avif, 'avif'],
		['https://img.afxengine.com/a/b/c.jpg?width=64', 'image/webp,*/*', 'webp'],
		['https://img.afxengine.com/a/b/c.jpg?width=64', 'image/*', 'jpeg'],
		['https://img.afxengine.com/a/b/c.jpg?width=64', null, 'jpeg'],
		['https://img.afxengine.com/a/b/c.jpg?width=64&format=auto', avif, 'avif'],
		['https://img.afxengine.com/a/b/c.jpg?width=64&format=png', avif, 'asked'],
		['https://img.afxengine.com/a/b/logo.svg', avif, 'svg'],
	])('%s with Accept %s is %s', (url, accept, format) => {
		expect(negotiatedFormat(req(url, accept))).toBe(format);
	});

	it('leads with the format, then the path and query as requested', () => {
		expect(transformCacheKey(req('https://img.afxengine.com/a/b/c.jpg?width=64&quality=80', avif))).toBe('/v1/avif/a/b/c.jpg?width=64&quality=80');
		expect(transformCacheKey(req('https://img.afxengine.com/a/b/c.jpg', 'image/*'))).toBe('/v1/jpeg/a/b/c.jpg');
	});

	it.each([
		['/afx-site/acme/media_1/photo.jpg', ['key:afx-site/acme/media_1/photo.jpg', 'tenant:acme']],
		['/afx-site-staging/acme/media_1/tok/photo.jpg', ['key:afx-site-staging/acme/media_1/tok/photo.jpg', 'tenant:acme']],
		['/clients/example/cover.jpg', ['key:clients/example/cover.jpg']],
		['/web/ae-og-image.png', ['key:web/ae-og-image.png']],
	])('tags %s as %s', (pathname, tags) => {
		expect(cacheTagsFor(pathname)).toEqual(tags);
	});
});

describe('gateway', () => {
	beforeAll(() => {
		fetchMock.activate();
		fetchMock.disableNetConnect();
	});
	afterEach(() => fetchMock.assertNoPendingInterceptors());
	afterAll(() => fetchMock.deactivate());

	const path = '/afx-site/acme/media_2/photo.jpg';
	const reply = (headers = {}) =>
		fetchMock
			.get(env.CDN_ORIGIN)
			.intercept({ path })
			.reply(200, 'bytes', { headers: { 'Content-Type': 'image/avif', 'cf-resized': 'internal=ok/m', ...headers } });

	it('marks a negotiated answer as varying by Accept', async () => {
		reply();
		const response = await workerFetch(new Request(`https://img.afxengine.com${path}?width=64`, { headers: { Accept: 'image/avif,*/*' } }));
		expect(response.status).toBe(200);
		expect(response.headers.get('Vary')).toBe('Accept');
	});

	it('does not vary an explicitly requested format', async () => {
		reply();
		const response = await workerFetch(new Request(`https://img.afxengine.com${path}?width=64&format=png`, { headers: { Accept: 'image/avif,*/*' } }));
		expect(response.status).toBe(200);
		expect(response.headers.get('Vary')).toBeNull();
	});

	it('serves the Transform entrypoint directly', async () => {
		reply();
		const ctx = createExecutionContext();
		const response = await ctx.exports.Transform.fetch(new Request(`https://img.afxengine.com${path}?width=64`, { headers: { Accept: 'image/avif,*/*' } }));
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
		expect(response.headers.get('Vary')).toBeNull();
	});
});

describe('purge validation', () => {
	const headers = () => ({ Authorization: `Bearer ${env.IMG_API_SECRET}`, 'Content-Type': 'application/json' });
	const purge = (body) => workerFetch(new Request('https://img.afxengine.com/purge', { method: 'POST', headers: headers(), body: JSON.stringify(body) }));

	it('rejects a body naming nothing', async () => {
		expect((await purge({})).status).toBe(400);
	});

	it('rejects an invalid url', async () => {
		expect((await purge({ url: 'not a url' })).status).toBe(400);
	});

	it('rejects a tenant slug that is not one', async () => {
		expect((await purge({ tenants: ['../x'] })).status).toBe(400);
	});

	it('purges a tenant by tag', async () => {
		const response = await purge({ tenants: ['acme'] });
		const body = await response.json();
		expect(body.purgedTenants).toEqual(['acme']);
		expect([200, 502]).toContain(response.status);
	});

	it('rejects more urls and tenants than one purge call can name', async () => {
		const urls = Array.from({ length: 31 }, (_, i) => `https://img.afxengine.com/a/${i}.jpg`);
		expect((await purge({ urls })).status).toBe(400);
	});

	it('answers with the paths it purged and the runtime result', async () => {
		const response = await purge({ url: 'https://img.afxengine.com/afx-site/acme/media_1/photo.jpg?width=64' });
		const body = await response.json();
		expect(body.purged).toEqual(['afx-site/acme/media_1/photo.jpg']);
		expect(typeof body.success).toBe('boolean');
		expect([200, 502]).toContain(response.status);
	});
});
