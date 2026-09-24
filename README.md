> **Ghi chú (repo giờ có 2 tầng):** Từ khi thêm **Tổng Đài** — lớp marketplace
> nhiều merchant phía trên module này — toàn bộ nội dung README này mô tả
> **A Tiểu Merchant Module** (`src/`), vẫn chạy độc lập y như trước, không hề
> sửa. Lớp platform mới (`platform/`) coi module này là merchant đầu tiên và
> route vào nó không đổi 1 dòng code nào ở đây. Xem **`platform/README.md`**
> cho kiến trúc marketplace/discovery/AI concierge.

# Zalo OA Ordering Engine — Hủ Tiếu Xào A Tiểu

Backend production cho luồng: khách tìm quán trên Zalo → quan tâm OA → mở chat
→ xem menu → hỏi/chọn món bằng ngôn ngữ tự nhiên → thêm/sửa giỏ hàng → xác nhận
đơn → hệ thống tạo Order → quán nhận thông báo.

## 1. Kiến trúc

```
Zalo OA
  │ webhook
  ▼
Webhook Controller (src/channel/zalo/webhookController.js)
  │ verify (best-effort, off by default) → normalize → idempotency reserve
  ▼
Message Normalizer (src/channel/zalo/messageNormalizer.js)
  ▼
Session Manager (src/services/sessionService.js)
  ▼
Intent Engine (src/nlp/intentEngine.js — rule-based, không gọi LLM)
  ▼
Business Router (src/router/businessRouter.js)
  ├── FAQ (store_location / opening_hours / payment_method / delivery / promotion)
  ├── Menu     → MenuService
  ├── Cart     → CartService
  ├── Order    → OrderService
  └── Human handoff
  ▼
Domain Services (src/services/*) — toàn bộ tính giá/tổng/state đều ở đây,
KHÔNG ở classifier, KHÔNG ở AI.
  ▼
Repositories (src/repositories/*) — SQL duy nhất nằm ở đây, không rải trong
controller/service.
  ▼
SQLite (better-sqlite3, migration-based schema, src/db/)
  ▼
Notification Service (Telegram nếu cấu hình, log nếu chưa — không bao giờ báo
"đã gửi" khi chưa gửi được)
  ▼
Zalo Send API (src/channel/zalo/client.js — retry + timeout + không retry lỗi 4xx)
```

**AI layer** (`src/ai/`) là lớp hiểu ngôn ngữ tuỳ chọn, đứng ngoài luồng quyết
định: mặc định `AI_PROVIDER=null` — không gọi LLM nào, toàn bộ intent/entity
đến từ rule engine. Nếu bật `AI_PROVIDER=anthropic`, AI chỉ được dùng để (a)
gợi ý intent/entity cho câu rule engine không phân loại được, và (b) viết lại
câu trả lời tự nhiên hơn — luôn giữ nguyên số liệu đã tính. AI không bao giờ
được gọi để quyết định giá, tổng tiền, tồn tại sản phẩm, hay trạng thái đơn —
xem hợp đồng trong `src/ai/AIProvider.js`.

## 2. Database schema

SQLite, quản lý qua migration (`src/db/migrations/001_init.sql`), abstraction
qua repository layer (`src/repositories/`) — không có SQL rải trong
controller. Muốn chuyển Postgres: chỉ cần viết lại các repository, phần
service/router/API giữ nguyên.

Bảng: `customers`, `sessions`, `messages`, `webhook_events` (idempotency),
`categories`, `products`, `product_options`, `carts`, `cart_items`, `orders`,
`order_items`, `order_events`, `business_settings`, `promotions`,
`notifications`.

Toàn bộ cột tiền là **integer VND** — không float, không nhận giá/tổng từ
client.

## 3. Cài đặt

```bash
npm install
cp .env.example .env
npm run migrate   # tạo schema
npm run seed      # nạp categories/products/business_settings — idempotent
npm start
```

Điền `.env` theo bảng dưới (chi tiết từng biến xem `.env.example`):

| Nhóm | Biến chính |
|---|---|
| Zalo OA | `ZALO_OA_ACCESS_TOKEN`, `ZALO_OA_SECRET_KEY`, `WEBHOOK_PATH` |
| AI (tuỳ chọn) | `AI_PROVIDER`, `ANTHROPIC_API_KEY` |
| DB | `SQLITE_PATH` |
| Notification | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` |
| Business | `ORDER_CODE_PREFIX`, `MAX_ITEM_QUANTITY` |

## 4. Menu / Seed data

`data/seed/products.json` hiện có **đúng 4 món đã được xác nhận**:

| Món | Giá |
|---|---|
| Hủ Tiếu Xào Bò | 65.000đ |
| Hủ Tiếu Xào Hải Sản | 75.000đ |
| Hủ Tiếu Xào Thập Cẩm | 60.000đ |
| Hủ Tiếu Xào Đặc Biệt | 85.000đ |

Hệ thống **không tự bịa** món/giá/khuyến mãi nào khác. Xem
`data/seed/NEEDS_OWNER_INPUT.md` — danh sách dữ liệu chủ quán cần bổ sung
(phí giao hàng thật, giờ mở cửa thật, địa chỉ, SĐT quán, khuyến mãi...) trước
khi go-live. Sau khi sửa seed, chạy lại `npm run seed` (an toàn, idempotent,
upsert theo `sku`/`name`/`key`, không xoá cart/order hiện có).

## 5. Test

```bash
npm test
```

54 test cases, 3 tầng:

- **Unit** (`test/unit/`): money helpers, order state machine, intent
  classifier — chạy không cần DB.
- **Integration** (`test/integration/`): CartService, OrderService,
  NotificationService trên SQLite in-memory.
- **E2E** (`test/e2e/`): toàn bộ hội thoại (chào → menu → thêm món → giỏ →
  checkout → xác nhận → notification), webhook HTTP thật (idempotency
  retry, Zalo send failure, DB failure, REST validation).

Đã verify PASS tại thời điểm viết README này: `npm test` → 54/54 pass.

**Chưa thể test với credential thật (BLOCKED):**

- Gửi tin thật qua Zalo Send API — cần `ZALO_OA_ACCESS_TOKEN` thật. Test hiện
  tại verify hệ thống xử lý đúng khi token thiếu/lỗi (fails cleanly, không
  giả vờ đã gửi). Cần test lại với OA thật trước khi go-live.
- Webhook signature verification (`src/channel/zalo/verifySignature.js`) —
  scheme hiện là best-effort dựa trên tài liệu tham khảo, **chưa xác nhận**
  đúng header/algorithm thật của Zalo OA. Đang tắt mặc định
  (`ENABLE_ZALO_SIGNATURE_CHECK=false`). Phải test với webhook thật từ Zalo
  trước khi bật.
- Telegram notification thật — cần `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`
  thật. Test hiện tại verify với mock send (thành công + thất bại), có test
  riêng xác nhận không log "sent" khi chưa cấu hình.

## 6. Zalo OA configuration

1. Deploy service có domain HTTPS công khai (hoặc ngrok khi test).
2. nginx reverse-proxy `https://yourdomain.com/zalo/webhook` →
   `http://127.0.0.1:3900/zalo/webhook` — **chỉ path này**. Không trỏ
   ngrok/tunnel vào cả port 3900: như vậy REST API không xác thực ở mục 7
   cũng bị public.
3. Trên [oa.zalo.me](https://oa.zalo.me) → OA của bạn → Webhook → khai báo
   URL trên, đăng ký event `user_send_text` (bắt buộc).
4. Lấy Access Token, điền `ZALO_OA_ACCESS_TOKEN`.
5. Zalo tính reply quota theo cửa sổ thời gian sau tin khách gửi — quán cần
   trả lời trong khung đó (hệ thống gửi realtime nên không phải lo, chỉ cần
   không để webhook bị lỗi/timeout).

## 7. REST API

> **Bảo mật:** REST API này KHÔNG có xác thực — ai gọi được tới port 3900
> đều tạo được đơn CONFIRMED (gửi thông báo Telegram cho quán), đổi trạng
> thái đơn, và đọc thông tin khách (SĐT, địa chỉ) theo id. Server lắng nghe
> trên mọi network interface. Không expose port 3900 ra Internet hay mạng
> LAN dùng chung: chỉ dùng từ localhost, và chỉ public `/zalo/webhook` qua
> reverse proxy (mục 6).

```
GET    /api/menu
GET    /api/menu/:id
POST   /api/cart/items          { customerId, productId, quantity }
PATCH  /api/cart/items/:id      { quantity }
DELETE /api/cart/items/:id
GET    /api/cart/:customerId
POST   /api/orders              { customerId, fulfillmentType, phone?, address? }
GET    /api/orders/:id
PATCH  /api/orders/:id/status   { status, note? }
GET    /api/customers/:id
GET    /api/health
GET    /api/readiness
POST   /zalo/webhook
```

Server luôn tự tra giá/tồn tại sản phẩm và tự tính tổng — client chỉ gửi
`productId` + `quantity`; mọi `price`/`total` gửi kèm trong body đều bị bỏ
qua.

`POST /api/orders` tạo đơn CONFIRMED ngay (khác chat flow có bước hỏi/xác
nhận riêng) — vì gọi endpoint này chính là hành động xác nhận từ phía client.

## 8. Notification

Khi order chuyển CONFIRMED, `NotificationService` gửi Telegram nếu
`TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` được cấu hình; nếu không, ghi log +
lưu record `notifications.status = 'skipped_no_channel'` — **không bao giờ**
báo đã gửi khi chưa gửi. Không gửi notification trước khi order đạt
CONFIRMED (có test riêng xác nhận điều này).

## 9. Order state machine

```
DRAFT → PENDING_CONFIRMATION → CONFIRMED → ACCEPTED → PREPARING → READY → COMPLETED
CANCELLED: được phép từ DRAFT, PENDING_CONFIRMATION, CONFIRMED, ACCEPTED, PREPARING
           KHÔNG được phép từ READY, COMPLETED
```

Mọi transition đi qua `src/domain/orderStateMachine.js` — chuyển trạng thái
không hợp lệ trả lỗi `INVALID_TRANSITION` (HTTP 409), không âm thầm bỏ qua.
Mỗi transition ghi 1 dòng `order_events`.

## 10. Idempotency

Webhook Zalo có thể retry — `webhook_events.message_id` có UNIQUE constraint,
request thứ 2 với cùng `message_id` trả về response đã cache, không xử lý
lại, không tạo đơn thứ 2. Có test HTTP-level xác nhận việc này.

## 11. Security

- Secrets chỉ qua env, không hard-code, `.env` trong `.gitignore`.
- `src/logger.js` tự động redact field tên chứa `token`/`secret`/`password`/…
- Rate limit in-memory theo IP cho toàn bộ `/api` + webhook.
- REST API `/api/*` không có xác thực — an toàn chỉ khi port 3900 không bị
  expose (xem mục 7 và 12).
- Validation tay cho mọi input REST (`src/api/middleware/validate.js`) —
  reject quantity ≤0, không phải integer, vượt `MAX_ITEM_QUANTITY`; reject
  product id không tồn tại; không bao giờ tin giá/tổng từ client hay từ AI.
- better-sqlite3 dùng prepared statements có tham số hoá — không nối chuỗi
  SQL từ input người dùng.

## 12. Deployment

```bash
docker build -t atieu-ordering-engine .
docker run -d --name atieu \
  --env-file .env \
  -v atieu-data:/data \
  -p 127.0.0.1:3900:3900 \
  atieu-ordering-engine
```

`-p 127.0.0.1:3900:3900` chỉ mở port trên loopback của máy host. Không dùng
`-p 3900:3900` — Docker sẽ mở trên mọi interface (và thường vượt qua
firewall của host), làm REST API không xác thực bị truy cập từ máy khác.

Image tự chạy `migrate` + `seed` (idempotent) trước khi start server. Nếu
`better-sqlite3` build native fail trên máy bạn (thiếu prebuilt binary cho
kiến trúc lạ), cài `build-essential python3` trước `npm ci`.

Không dùng Docker (chạy `npm start` trên Windows): server cũng lắng nghe
trên mọi interface — chặn inbound port 3900 bằng Windows Firewall (lệnh
`New-NetFirewallRule` trong `platform/README.md`, mục REST API).

Graceful shutdown: `SIGTERM`/`SIGINT` đóng HTTP server + DB connection trước
khi exit (`src/server.js`).

## 13. Production verification checklist

Trước khi coi là go-live:

- [ ] `npm test` PASS (đã verify: 54/54)
- [ ] `npm run migrate && npm run seed` PASS trên DB thật
- [ ] Webhook nhận được tin thật từ Zalo OA (không chỉ curl giả)
- [ ] Gửi reply thật thành công qua Zalo Send API (cần access token thật —
      BLOCKED cho tới khi có)
- [ ] Chủ quán xác nhận dữ liệu trong `NEEDS_OWNER_INPUT.md`
- [ ] Notification Telegram thật nhận được khi có đơn CONFIRMED
- [ ] Backup định kỳ file SQLite (`SQLITE_PATH`)

## 14. Cấu trúc thư mục

```
src/
  config.js, logger.js, server.js
  db/            migrations, connection, seed
  domain/        money, order state machine, order code, checkout field parsers — pure logic, no I/O
  repositories/  toàn bộ SQL
  services/      business logic (cart/order/menu/customer/session/notification)
  nlp/           rule-based intent classifier + entity helpers
  ai/            optional AI provider abstraction (Null/Anthropic)
  router/        BusinessRouter — nối intent -> domain services
  channel/zalo/  webhook controller, message normalizer, send client, signature check
  api/           Express app, REST routes, middleware
data/seed/       categories/products/business_settings — sửa ở đây để đổi menu/giá
test/            unit / integration / e2e
scripts/         migrate.js, seed.js
```
