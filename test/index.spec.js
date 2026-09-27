import { env, createExecutionContext, fetchMock, waitOnExecutionContext } from 'cloudflare:test';
import { afterAll, afterEach, beforeAll, describe, it, expect } from 'vitest';
import worker, { isStagingKey, isValidPath } from '../src';

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

	it('deletes a staging key from media-staging and never touches media', async () => {
		const path = 'afx-site-preview/acme/media_3/logo.png';
		await env.MEDIA_STAGING_BUCKET.put(path, 'staging');
		await env.MEDIA_BUCKET.put(path, 'production');
		expect((await remove('img.afxengine.com', path)).status).toBe(200);
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
