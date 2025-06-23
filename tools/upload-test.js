import 'dotenv/config'; // Automatically loads .env into process.env
import fs from 'fs';
//import path from 'path';

const API_URL = 'https://img.arroweffect.com/upload';
const TOKEN = process.env.IMG_API_TOKEN;
const FILE_PATH = './tools/test-image.jpg';
const DEST_PATH = 'tests/test-image.jpg';
const CONTENT_TYPE = 'image/jpeg';

if (!TOKEN) {
	console.error('❌ IMG_API_TOKEN is missing. Check your .env file.');
	process.exit(1);
}

(async () => {
	try {
		const fileBuffer = fs.readFileSync(FILE_PATH);
		const fileBase64 = fileBuffer.toString('base64');

		const res = await fetch(API_URL, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${TOKEN}`,
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
