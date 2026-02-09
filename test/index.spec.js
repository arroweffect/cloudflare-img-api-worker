import { env, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker, { isValidPath } from '../src';

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
			Authorization: `Bearer ${env.IMAGE_API_SECRET}`,
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
			Authorization: `Bearer ${env.IMAGE_API_SECRET}`,
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
