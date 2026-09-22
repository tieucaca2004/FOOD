// Local E2E smoke test — sends a sample Zalo webhook payload to a running
// server (npm start) and prints the result, mirroring the doc's §11 flow.
const BASE_URL = process.env.BASE_URL || "http://127.0.0.1:3900";
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || "/zalo/webhook";

const payload = {
  event_name: "user_send_text",
  sender: { id: "test-user-001" },
  message: { text: "gần đây có quán cháo vịt nào ngon không ạ?" },
  timestamp: Date.now(),
  message_id: `rt-${Math.random().toString(16).slice(2)}`,
};

const res = await fetch(`${BASE_URL}${WEBHOOK_PATH}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});

console.log(res.status, JSON.stringify(await res.json(), null, 2));
