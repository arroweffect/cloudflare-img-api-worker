import 'dotenv/config';

const API_URL = 'https://img.arroweffect.com/delete';
const TOKEN = process.env.IMG_API_TOKEN;
const DEST_PATH = 'tests/test-image.jpg';

if (!TOKEN) {
	console.error('❌ IMG_API_TOKEN is missing. Check your .env file.');
	process.exit(1);
}

(async () => {
	try {
		const res = await fetch(API_URL, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${TOKEN}`,
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
