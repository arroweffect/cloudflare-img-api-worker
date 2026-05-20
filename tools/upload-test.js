import 'dotenv/config'; // Automatically loads .env into process.env
import fs from 'fs';
//import path from 'path';

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

const API_URL = `${API_BASE}/upload`;
const FILE_PATH = './tools/test-image.jpg';
const DEST_PATH = 'img-api-tests/test-image.jpg';
const CONTENT_TYPE = 'image/jpeg';

(async () => {
	try {
		const fileBuffer = fs.readFileSync(FILE_PATH);
		const fileBase64 = fileBuffer.toString('base64');

		const res = await fetch(API_URL, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${SECRET}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				path: DEST_PATH,
				contentType: CONTENT_TYPE,
				fileBase64,
			}),
		});

		console.log(`✅ Status: ${res.status}`);
		const text = await res.text();
		console.log(`✅ Response: ${text}`);

		if (!res.ok) {
			process.exit(1);
		}
	} catch (err) {
		console.error('❌ Error during upload:', err);
		process.exit(1);
	}
})();
