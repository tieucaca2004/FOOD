# Tổng Đài — Zalo Marketplace Platform

Lớp **Platform Matrix** phía trên các merchant module. Khách hàng chỉ cần
quan tâm **một Zalo OA duy nhất** ("Tổng Đài"), nói nhu cầu bằng ngôn ngữ tự
nhiên, hệ thống tìm merchant phù hợp và route khách vào đúng merchant đó.

**A Tiểu (`src/`) là merchant implementation đầu tiên — không hề bị sửa.**
Platform coi nó là một "Merchant Matrix" chạy phía sau `AtieuMerchantAdapter`,
y hệt như khi chạy độc lập qua `npm start` ở gốc repo.

## 1. Kiến trúc

```
Zalo (Tổng Đài OA)
  │ webhook
  ▼
platform/channel/webhookController.js   (idempotent — UNIQUE message_id)
  ▼
platform/channel/../src/channel/zalo/messageNormalizer.js  (tái dùng, generic)
  ▼
platform/services/platformSessionService.js  (platform context vs merchant context)
  ▼
platform/nlp/concierge.js   (rule-based intent — KHÔNG gọi LLM để quyết định route)
  ▼
platform/router/PlatformRouter.js
  ├─ context = 'platform' → DiscoveryEngine → MerchantRouter.resolve → mở merchant
  └─ context = 'merchant' → MerchantRouter.routeMessage → merchant tự xử lý
  ▼
platform/discovery/DiscoveryEngine.js
  │ gọi adapter.searchProducts() của TỪNG merchant discoverable, tự rank
  ▼
platform/merchant/MerchantRegistry.js  →  platform/merchant/adapters/AtieuMerchantAdapter.js
  │ (bọc src/services + src/router/businessRouter.js — KHÔNG sửa 1 dòng)
  ▼
A Tiểu Merchant Matrix (src/) — menu/cart/order/state machine như cũ
```

AI (`platform/ai/`) chỉ được gọi khi rule engine trả `unknown`, và gợi ý của
nó (merchant name / search keywords) vẫn phải đi qua đúng
DiscoveryEngine/MerchantRegistry thật — AI không bao giờ tự mở merchant hay
tự tạo kết quả tìm kiếm. Xem `platform/merchant/MerchantModule.js` và
`src/ai/AIProvider.js` (tái dùng contract gốc) cho ranh giới này.

## 2. A Tiểu integration — cách hoạt động thật

`AtieuMerchantAdapter` (`platform/merchant/adapters/AtieuMerchantAdapter.js`)
**import trực tiếp** `src/services/index.js`, `src/router/businessRouter.js`
— tức là platform chạy CHÍNH engine A Tiểu, trong cùng process, cùng
`data/atieu.db`. Không có bản sao, không có logic viết lại.

**Vấn đề nhận dạng khách hàng:** trước đây khách nhắn trực tiếp OA của A
Tiểu, giờ khách chỉ nhắn OA Tổng Đài — không còn "Zalo user id của A Tiểu"
thật cho khách này. Adapter giải quyết bằng cách đồng bộ một id ổn định,
namespaced: `platform:<platform_customer_id>`, dùng làm `zalo_user_id` khi
gọi `services.customers.getOrCreateByZaloUserId(...)` của A Tiểu — A Tiểu
không biết (và không cần biết) nó đang được một platform proxy gọi vào.

**Order ownership:** đơn hàng A Tiểu tạo ra vẫn nằm 100% trong `atieu.db`
(bảng `orders` gốc, state machine gốc, không đổi). Platform **không sao
chép** đơn vào bảng `orders` của platform DB — bảng đó chỉ dành cho merchant
"generic" (data-driven, chưa có module riêng). Platform chỉ ghi
`merchant_events` (SEARCH/MERCHANT_VIEW/ADD_TO_CART/CHECKOUT_STARTED/
ORDER_CREATED) với `external_ref = order_code` của A Tiểu để làm analytics —
không phải nguồn sự thật thứ hai.

## 3. Cài đặt & chạy

```bash
npm install
cp .env.example .env    # đã có sẵn cả section PLATFORM_* — điền OA token của Tổng Đài
npm run platform:migrate
npm run platform:seed    # idempotent — CHỈ register ATIEU001 thật, không seed merchant giả
npm run platform:start   # chạy platform trên PLATFORM_PORT (mặc định 3901)
```

Platform tự boot CẢ engine A Tiểu bên trong (đọc/tạo `data/atieu.db` nếu
chưa có, migrate + seed y như `npm start` ở gốc làm) — không cần chạy
`npm start` riêng để platform hoạt động. Bạn vẫn CÓ THỂ chạy A Tiểu độc lập
song song (`npm start`, port 3900) nếu cần API/webhook riêng của nó — cả hai
process mở cùng file SQLite qua WAL, an toàn cho V1. Lưu ý: REST API của
A Tiểu trên port 3900 **không có xác thực** và lắng nghe trên mọi interface
— không trỏ tunnel/Cloudflare vào port 3900 (tunnel của platform trỏ vào
3901), xem README gốc mục 7.

## 4. Test

```bash
npm run test:platform   # 41 test, riêng platform layer
npm test                # 54 test, A Tiểu — PHẢI vẫn pass sau khi thêm platform
npm run test:all        # cả hai
```

Đã verify PASS tại thời điểm viết README này: **95/95** (54 A Tiểu không đổi
+ 41 platform mới), chạy `npm run test:all` không lỗi.

Test platform dùng **A Tiểu engine in-memory thật** qua
`test/helpers/testApp.js` (helper gốc của A Tiểu, không sửa) — không mock A
Tiểu, chứng minh integration là thật.

**Merchant thứ 2 dùng để test multi-merchant discovery/ranking
(`TESTFIXTURE001`) chỉ tồn tại trong `platform/test/helpers/testPlatform.js`
— KHÔNG có trong `platform/db/seed.js` (production seed chỉ register
ATIEU001 thật).** Xem quyết định này đã được xác nhận với người dùng trước
khi implement.

## 5. Database

Platform DB (`platform/db/migrations/001_platform_init.sql`) hoàn toàn tách
biệt khỏi A Tiểu DB: `merchants, merchant_users, merchant_settings,
merchant_subscriptions, merchant_categories, merchant_products (chỉ cho
merchant generic), platform_customers, platform_sessions, platform_messages,
merchant_sessions, orders/order_items/payments/deliveries (chỉ cho merchant
generic), search_events, merchant_events, plans, platform_webhook_events`.

## 6. Merchant status & subscription

```
PENDING → (admin activate) → ACTIVE | TRIAL → SUSPENDED/EXPIRED/CLOSED
```

Chỉ `ACTIVE`/`TRIAL` được Discovery trả về (`platform/domain/merchantStatus.js`).
`activate` chỉ duyệt merchant PENDING hoặc mở lại merchant bị SUSPENDED; nó
**từ chối** (`400 SUBSCRIPTION_EXPIRED`) khi subscription đã hết hạn — đưa
merchant hết hạn trở lại là việc của `renew()` (spec §43, cần xác nhận thanh
toán; hiện chưa có endpoint).
`trial_days` không hard-code — lấy từ `plans.trial_days`, fallback
`DEFAULT_TRIAL_DAYS` env (`platform/domain/subscription.js`).

## 7. Ranking & sponsored

`platform/domain/ranking.js` luôn tách `organic` và `sponsored` thành 2 danh
sách riêng — hiện tại **không có merchant nào trả tiền quảng bá** (field
`merchants.sponsored` mặc định `false` cho mọi merchant, kể cả A Tiểu), nên
`sponsored` luôn rỗng trong thực tế cho tới khi có merchant thật mua quảng
bá. Không có kết quả "giả danh organic".

## 8. REST API (admin/onboarding/debug)

```
# Admin — Authorization: Bearer <PLATFORM_ADMIN_API_TOKEN>
GET    /api/platform/merchants
GET    /api/platform/merchants/:id
POST   /api/platform/merchants        { merchantId, name, slug, module, ... }
PATCH  /api/platform/merchants/:id/status   { action: 'activate'|'suspend'|'close' }
POST   /api/platform/merchants/:id/api-keys  → { api_key } (chỉ trả về 1 lần)

# Merchant — Authorization: Bearer <api_key của merchant>
GET    /api/platform/merchant/orders
GET    /api/platform/merchant/orders/:orderId
POST   /api/platform/merchant/orders/:orderId/receive

# Public
GET    /api/platform/search?q=...
GET    /api/platform/health
GET    /api/platform/readiness

# Webhook (xác thực bằng chữ ký Zalo / secret token Telegram)
POST   /platform/webhook
POST   /api/platform/webhook/telegram
```

Rate limit theo IP client. Mặc định không tin proxy nào
(`PLATFORM_TRUST_PROXY` rỗng): đứng sau tunnel chạy trên cùng máy
(cloudflared), mọi client đều hiện là 127.0.0.1 và dùng chung **một** bucket
— kể cả webhook Telegram. Đặt `PLATFORM_TRUST_PROXY=loopback` chỉ khi đã xác
nhận proxy local thêm IP thật của client vào CUỐI `X-Forwarded-For`; giá trị
`true`, số hop, `*`, subnet `/0` bị từ chối (server log cảnh báo).

Admin API **fail closed**: nếu `PLATFORM_ADMIN_API_TOKEN` chưa đặt hoặc ngắn
hơn 32 ký tự, mọi request admin trả `503 admin_api_disabled`. Sai/thiếu
token → `401 unauthenticated`. API key của merchant không dùng được cho
admin API, và admin token không dùng được cho route merchant.

Chọn quán sau khi tìm (chat): kết quả tìm kiếm được đánh số `[1]`, `[2]`…
theo đúng thứ tự lưu trong session. Ngay sau danh sách đó, khách gõ số
(`1`, `quán số 2`, `chọn quán 2`), `ok`/`chọn quán này` (chỉ khi danh sách
có đúng 1 quán — nhiều quán thì hỏi lại, không đoán), hoặc tên quán không kèm
động từ (`A Tiểu`, chỉ khi không phải tên món và khớp đúng 1 quán trong danh
sách). Danh sách chỉ có hiệu lực cho lượt ngay sau nó: tìm mới thay thế nó,
mọi lượt khác (chào, mở quán…) xoá nó; chọn sai số/`ok` khi nhiều quán thì
giữ lại để chọn lại. `vào quán <tên>` mở quán theo tên như `xem <tên>`.

Onboarding một merchant mới (spec §31): `create merchant` (PENDING) →
`admin activate` → merchant xuất hiện trong Discovery. **Không cần sửa**
AI Concierge / DiscoveryEngine / PlatformRouter / MerchantRegistry cho
merchant loại `generic` — chỉ cần thêm dữ liệu qua
`merchant_categories`/`merchant_products`.

## 9. Zalo capability rule (spec §35)

Chưa xác minh Zalo Mini App / rich menu / button template / location share
với tài liệu Zalo chính thức trong session này — nên **chưa implement**.
`platform/channel/zaloClient.js` chỉ gửi text (giống cách A Tiểu đã làm),
đúng với yêu cầu "text chat vẫn phải hoạt động". Merchant card hiện là text
có format rõ ràng (tên IN HOA, emoji món, `[ XEM <TÊN> ]`) — sẵn sàng thay
bằng structured template thật một khi đã xác minh API, không cần đổi
DiscoveryEngine/PlatformRouter.

Webhook signature (`PLATFORM_ENABLE_ZALO_SIGNATURE_CHECK`) — cùng tình
trạng best-effort/chưa xác minh như A Tiểu, nhưng **mặc định BẬT (fail
closed)**: chỉ tắt khi đặt đúng `false`. Khi bật mà thiếu
`PLATFORM_ZALO_OA_SECRET_KEY` thì mọi request Zalo bị từ chối (401). Tắt
nghĩa là bất kỳ ai gọi được webhook đều có thể gửi tin giả danh bất kỳ
Zalo user nào — server log cảnh báo khi khởi động.

## 10. BLOCKED / chưa thể test với credential thật

- Gửi tin thật qua Zalo Send API của Tổng Đài OA — cần
  `PLATFORM_ZALO_OA_ACCESS_TOKEN` thật (khác token của A Tiểu).
- Webhook signature verification thật.
- Merchant "generic" đặt món qua chat (`GenericMerchantAdapter.handleMessage()`
  + `platform/nlp/genericOrderIntent.js`, dùng CartService/OrderService có
  sẵn): "xem menu", "cho tôi 2 <món>", "thêm 1 <món>", "xem giỏ hàng",
  "xóa giỏ hàng", "đặt hàng". "đặt hàng" tạo đơn ngay (đúng hợp đồng
  `confirmOrder(customerId, cartId)`, không có bước "xác nhận" riêng và chưa
  có lệnh hủy đơn qua chat). Chưa có kênh đẩy đơn tới quán
  (`NullMerchantDispatchPort`): đơn ở trạng thái CREATED cho tới khi quán lấy
  qua merchant API (`/api/platform/merchant/orders`).
- `MerchantModule.isOpenNow()` luôn trả `{known:false}` cho A Tiểu vì
  `opening_hours` trong seed A Tiểu là placeholder chưa xác nhận — Discovery
  không loại/không gắn nhãn "đang mở" cho tới khi có giờ mở cửa thật, có cấu
  trúc (JSON schedule), không phải chuỗi tự do.
- `PaymentService`/`DeliveryService` chỉ có `NullPaymentProvider`/
  `NullDeliveryProvider` — không tích hợp gateway/vận chuyển thật, không
  bao giờ báo PAID/DELIVERED giả.

## 11. Cấu trúc thư mục

```
platform/
  config.js
  db/            migrations, connection (bookkeeping riêng, không đụng src/db/), seed (chỉ ATIEU001 thật)
  domain/        merchantStatus, subscription (trial config), ranking, paymentStatus
  repositories/  toàn bộ SQL platform
  services/      merchantService (onboarding/lifecycle), subscriptionService, payment/delivery (Null providers), customer/session
  nlp/           concierge.js — rule-based intent cho tổng đài
  ai/            optional AI fallback, tái dùng contract AIProvider của A Tiểu
  merchant/
    MerchantModule.js        interface mọi merchant adapter phải theo
    MerchantRegistry.js      module -> adapter factory
    MerchantRouter.js        merchant_id -> route message
    adapters/
      AtieuMerchantAdapter.js    bọc src/ thật, không sửa
      GenericMerchantAdapter.js  data-driven, cho merchant tương lai chưa cần code riêng
  discovery/     DiscoveryEngine — search xuyên merchant, rank, tách sponsored
  router/        PlatformRouter — platform context vs merchant context
  channel/       webhook controller + Zalo client riêng (OA khác A Tiểu)
  api/           Express app riêng, port riêng
  scripts/       migrate.js, seed.js
  test/          unit / integration / e2e (41 test)
```
