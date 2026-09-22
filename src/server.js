import express from "express";
import { config } from "./config.js";
import { classifyIntent } from "./classifier/intent.js";
import { buildReply } from "./responder/index.js";
import { sendTextMessage } from "./zalo/client.js";
import {
  getOrCreateOpenSession,
  setSessionIntent,
  insertMessage,
  updateMessageStatus,
} from "./db.js";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

app.post(config.webhookPath, async (req, res) => {
  const body = req.body || {};

  if (body.event_name !== "user_send_text") {
    // Ack anything else (delivery receipts, follow/unfollow, ...) without processing.
    return res.json({ status: "ignored", event_name: body.event_name || null });
  }

  const zaloUserId = body.sender?.id;
  const userText = body.message?.text;

  if (!zaloUserId || typeof userText !== "string") {
    return res.status(400).json({ status: "error", error: "missing sender.id or message.text" });
  }

  const session = getOrCreateOpenSession(zaloUserId);

  const { intent, confidence } = classifyIntent(userText);
  const effectiveIntent = confidence >= config.minConfidence ? intent : "support_other_ambiguous";
  setSessionIntent(session.support_session_id, effectiveIntent);

  insertMessage({
    supportSessionId: session.support_session_id,
    senderType: "user",
    messageStatus: "received",
    rawText: userText,
  });

  const draftReply = await buildReply(effectiveIntent, userText);

  const messageId = insertMessage({
    supportSessionId: session.support_session_id,
    senderType: "agent",
    agentIdentity: "mary",
    messageStatus: "draft",
    rawText: draftReply,
  });

  const sendResult = await sendTextMessage(zaloUserId, draftReply);
  updateMessageStatus(messageId, sendResult.ok ? "sent" : "failed");

  return res.json({
    status: "processed",
    support_session_id: session.support_session_id,
    intent: effectiveIntent,
    confidence,
    draft_reply: draftReply,
    responder: "mary_food_bot",
    respond_error: sendResult.ok ? null : sendResult.error,
  });
});

app.listen(config.port, () => {
  console.log(`F&B support bot listening on :${config.port} (webhook: ${config.webhookPath})`);
});
