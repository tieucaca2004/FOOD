# F&B Support Bot cho Zalo OA

Bot CS ẩm thực chạy trên **Zalo Official Account**, dựa theo kiến trúc mô tả trong
`F_B_Support_System_v1.md` (Zalo webhook → phân loại intent → responder trả lời
theo dữ liệu quán ăn đã seed → gửi lại qua Zalo → lưu Postgres/SQLite).

Đây là bản **gọn, tự chứa** của kiến trúc đó — một service Node.js duy nhất
(thay cho cụm Hermes + Vellum daemon nhiều host trong tài liệu gốc), dùng
SQLite tại chỗ thay Postgres, và không cần hạ tầng riêng để chạy được ngay.

## Luồng xử lý

```
Zalo OA  →  POST /zalo/webhook  →  classifyIntent()  →  buildReply()
                                                            │
                                        (nếu là hỏi quán ăn) ▼
                                        đọc data/restaurants.json (seed)
                                        → CHỈ liệt kê quán có trong seed,
                                          không tự bịa
                                                            │
                                                            ▼
                                        sendTextMessage() → Zalo Send API
                                                            │
                                                            ▼
                                        lưu session + message vào SQLite
```

Nguyên tắc giữ từ tài liệu gốc: **không bịa dữ liệu quán ăn** — bot chỉ liệt
kê đúng những gì có trong `data/restaurants.json`. Nếu câu hỏi không khớp
quán nào, bot xin thêm thông tin thay vì từ chối/redirect Google Maps.

## Cài đặt

```bash
npm install
cp .env.example .env
```

Điền vào `.env`:

| Biến | Ý nghĩa |
|---|---|
| `ZALO_OA_ACCESS_TOKEN` | Access token của Zalo OA (lấy từ [oa.zalo.me](https://oa.zalo.me) → app của bạn) |
| `ZALO_OA_APP_SECRET` | App secret, dùng nếu bạn muốn tự verify signature webhook |
| `PORT` | Cổng chạy server (default `3900`) |
| `MIN_CONFIDENCE` | Ngưỡng confidence để nhận intent (default `0.60`, giống Hermes trong tài liệu gốc) |
| `ANTHROPIC_API_KEY` | (tuỳ chọn) Nếu có, Claude sẽ viết lại câu trả lời tự nhiên hơn — nhưng chỉ dựa đúng trên danh sách quán đã match, không được thêm quán khác. Không set thì bot dùng template có sẵn. |
| `DB_PATH` | Đường dẫn file SQLite (default `./data/support.db`) |

Chạy server:

```bash
npm start        # production
npm run dev       # auto-reload khi sửa code
```

## Kết nối với Zalo OA

1. Deploy service này lên một host có domain HTTPS công khai (hoặc dùng
   ngrok/cloudflared khi test), route `/zalo/webhook` phải public — ví dụ
   nginx reverse-proxy `https://yourdomain.com/zalo/webhook` →
   `http://127.0.0.1:3900/zalo/webhook`, tương tự mục 4.1 trong tài liệu gốc.
2. Vào [Zalo OA Manage](https://oa.zalo.me) → chọn OA → **Webhook** → khai
   báo URL `https://yourdomain.com/zalo/webhook` và các event cần
   (`user_send_text` là bắt buộc cho bot này).
3. Lấy **Access Token** từ OA (hoặc qua OAuth flow nếu bạn dùng app riêng)
   và điền vào `.env`.
4. Zalo tính **reply quota** — chỉ gửi được reply trong khoảng thời gian sau
   khi user nhắn trước (giống mục 4.3 tài liệu gốc).

## Seed dữ liệu quán ăn

Sửa `data/restaurants.json` — mỗi entry:

```json
{
  "id": "slug-duy-nhat",
  "name": "Tên quán",
  "dish_tags": ["từ khoá món ăn dùng để match"],
  "area": "Khu vực/thành phố",
  "address": "Địa chỉ đầy đủ",
  "price_range": "khoảng giá",
  "notes": "ghi chú thêm (optional)"
}
```

> Dữ liệu 4 quán có sẵn trong repo là **dữ liệu mẫu để test** — hãy thay bằng
> danh sách quán thật đã xác minh trước khi chạy production, để tránh đúng
> lỗi mà tài liệu gốc cảnh báo: bot liệt kê thông tin sai/chưa xác minh.

## Test E2E cục bộ

```bash
npm start                 # terminal 1
npm run test:e2e          # terminal 2 — gửi câu "quán cháo vịt" mẫu, in kết quả
```

Kiểm tra thủ công thêm:

```bash
curl -s -X POST http://127.0.0.1:3900/zalo/webhook \
  -H 'content-type: application/json' \
  -d '{"event_name":"user_send_text","sender":{"id":"test-user"},"message":{"text":"gần đây có quán cháo vịt nào ngon không?"},"timestamp":0,"message_id":"m1"}'
```

Response mẫu:

```json
{
  "status": "processed",
  "support_session_id": "...",
  "intent": "support_food_recommendation",
  "confidence": 0.9,
  "draft_reply": "Dạ có, em gợi ý mấy quán sau nha: ...",
  "responder": "mary_food_bot",
  "respond_error": null
}
```

`respond_error` sẽ báo lỗi nếu `ZALO_OA_ACCESS_TOKEN` chưa đúng — khi test
cục bộ không có token thật thì lỗi này là bình thường, phần intent/seed vẫn
chạy đúng.

## Cấu trúc project

```
src/
  server.js               Express app, route webhook chính
  config.js                Load .env
  db.js                    SQLite schema + helpers (sessions/messages)
  classifier/intent.js     Rule-based intent classifier
  responder/
    index.js               Router intent → reply
    foodRecommender.js      Match seed data theo từ khoá/khu vực
    llm.js                  (optional) polish câu trả lời bằng Claude, luôn grounded theo seed
  zalo/client.js           Gửi message qua Zalo OA Send API
data/restaurants.json      Seed dữ liệu quán ăn — SỬA FILE NÀY để thêm quán thật
scripts/test-webhook.js    Script test E2E nhanh
```

## Mở rộng

- Thêm intent mới: sửa `src/classifier/intent.js`, thêm rule + xử lý tương
  ứng trong `src/responder/index.js`.
- Đổi seed store sang Postgres nếu cần scale nhiều host giống tài liệu gốc —
  chỉ cần thay `foodRecommender.js` đọc từ DB thay vì file JSON, phần còn lại
  không đổi.
- Verify webhook signature: Zalo OA không luôn gửi header ký riêng cho route
  message — nếu cần, dùng `ZALO_OA_APP_SECRET` để verify theo tài liệu Zalo
  OA API chính thức trước khi xử lý `req.body`.
