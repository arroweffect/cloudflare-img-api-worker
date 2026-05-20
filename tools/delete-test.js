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

const API_URL = `${API_BASE}/delete`;
const DEST_PATH = 'tests/test-image.jpg';

(async () => {
	try {
		const res = await fetch(API_URL, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${SECRET}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				path: DEST_PATH,
			}),
		});

		const data = await res.json();
		console.log(`✅ Status: ${res.status}`);
		console.log(`✅ Response:`, data);

		if (!res.ok) {
			process.exit(1);
		}
	} catch (err) {
		console.error('❌ Delete error:', err);
		process.exit(1);
	}
})();
