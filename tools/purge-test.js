import 'dotenv/config';

const API_BASE = process.env.IMG_API_BASE;
const SECRET = process.env.IMG_API_SECRET;

if (!API_BASE) {
	console.error('❌ IMG_API_BASE is missing. Check your .env file.');
	process.exit(1);
}
if (!SECRET) {
	console.error('❌ IMG_API_SECRET is missing. Check your .env file.');
	process.exit(1);
}

const API_URL = `${API_BASE}/purge`;
const TARGET_URL = `${API_BASE}/tests/test-image.jpg`;

(async () => {
	try {
		const res = await fetch(API_URL, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${SECRET}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				url: TARGET_URL,
			}),
		});

		const data = await res.json(); // Parse the JSON response body

		console.log(`✅ Status: ${res.status}`);
		console.log(`✅ Response:`, data);

		if (!res.ok) {
			process.exit(1);
		}
	} catch (err) {
		console.error('❌ Purge error:', err);
		process.exit(1);
	}
})();
