import { config } from "../config.js";

// Optional: ask Claude to phrase the reply naturally, but it is only ever
// given the already-matched seed entries as context and is explicitly told
// not to add anything beyond them. If no API key is configured, or the call
// fails, the caller falls back to the deterministic template — so the bot
// never depends on the LLM to avoid hallucinating.
export async function polishFoodReply(userText, restaurants) {
  if (!config.anthropicApiKey || restaurants.length === 0) return null;

  const seedContext = JSON.stringify(restaurants, null, 2);
  const system =
    "Bạn là Mary, nhân viên CS ẩm thực thân thiện, trả lời qua Zalo cho khách. " +
    "CHỈ được liệt kê các quán có trong SEED_DATA dưới đây, không được thêm quán nào khác, " +
    "không suy diễn địa chỉ hay thông tin không có trong dữ liệu. Giọng văn ngắn gọn, lịch sự, dùng 'dạ/ạ'.";

  const userPrompt = `Khách hỏi: "${userText}"\n\nSEED_DATA (chỉ dùng đúng các quán này):\n${seedContext}\n\nHãy soạn câu trả lời liệt kê các quán trên cho khách.`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.anthropicApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 500,
        system,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = data?.content?.find((c) => c.type === "text")?.text;
    return text || null;
  } catch {
    return null;
  }
}
