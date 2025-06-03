require('dotenv').config();
const base64String = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
const decodedString = Buffer.from(base64String, 'base64').toString('utf-8');
try {
  const json = JSON.parse(decodedString);
  console.log("Parsed successfully:", json.project_id);
} catch (error) {
  console.error("Error:", error.message);
}