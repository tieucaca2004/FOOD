# FOOD Platform + Telegram tự chạy lại sau khi Windows khởi động lại

Mục tiêu: tắt máy/khởi động lại Windows xong, **không cần làm gì**, bot Telegram
vẫn trả lời. Không đổi webhook bằng tay mỗi lần.

## Kiến trúc

**Trước (Quick Tunnel — không dùng cho vận hành):**

```
Telegram → https://<tên-ngẫu-nhiên>.trycloudflare.com  (đổi mỗi lần chạy lại cloudflared)
         → cloudflared tunnel --url http://localhost:3901  (chạy tay)
         → FOOD Platform :3901  (npm run platform:start, chạy tay)
```

Mỗi lần khởi động lại: URL đổi → webhook Telegram trỏ vào URL cũ → Cloudflare
trả **530** → bot im lặng, phải `setWebhook` lại bằng tay.

**Sau (Named Tunnel + Task Scheduler):**

```
Telegram → https://telegram.<domain-của-bạn>/api/platform/webhook/telegram   (cố định)
         → Cloudflare Named Tunnel "food-platform"   (task "FOOD Cloudflare Tunnel")
         → http://localhost:3901
         → FOOD Platform                             (task "FOOD Platform")
```

- Hostname cố định → webhook chỉ cần đặt **một lần**.
- Hai scheduled task trong thư mục `\FOOD\` của Task Scheduler tự chạy khi
  Windows khởi động (không cần đăng nhập) và khi bạn đăng nhập.
- Mỗi task chạy một script giám sát: tiến trình chết thì chạy lại (chờ 10s,
  20s… tối đa 60s); chết quá 5 lần trong 10 phút thì **dừng hẳn** và ghi
  `GAVE UP` vào log — không có vòng lặp khởi động lại vô hạn.
- Không bao giờ có 2 platform hay 2 cloudflared: task chỉ cho 1 instance, và
  script thoát ngay nếu port 3901 / tunnel đã có tiến trình chạy.
- Server **không** gọi `setWebhook` khi khởi động; không có gì trong luồng
  Telegram bị thay đổi.

## 0. Cần chuẩn bị (không thể tự đoán)

| Cần | Lấy ở đâu | Vì sao |
|---|---|---|
| Một **domain đã thêm vào Cloudflare** (DNS do Cloudflare quản lý) | dash.cloudflare.com → *Websites*. Chưa có thì mua domain rồi *Add a site*, đổi nameserver sang Cloudflare | Named Tunnel cần một hostname thật trong zone của bạn; `trycloudflare.com` không dùng được |
| **Hostname** sẽ dùng, VD `telegram.<domain>` | Bạn tự chọn | Trở thành URL webhook cố định |
| Quyền **Administrator** trên máy Windows | — | Tạo task chạy lúc khởi động |
| Node.js 22 và `cloudflared` trong `PATH` | Bước 1 | Task gọi trực tiếp `node.exe` và `cloudflared.exe` |

Kiểm tra máy đã có gì chưa (PowerShell):

```powershell
cloudflared --version
Test-Path "$env:USERPROFILE\.cloudflared\cert.pem"   # True = đã đăng nhập Cloudflare
cloudflared tunnel list                               # cần cert.pem; liệt kê tunnel đã có
node --version
```

## 1. Cài cloudflared (một lần)

```powershell
winget install --id Cloudflare.cloudflared
# mở cửa sổ PowerShell mới rồi:
cloudflared --version
```

## 2. Đăng nhập Cloudflare (một lần)

```powershell
cloudflared tunnel login
```

Trình duyệt mở ra → chọn domain ở bảng trên → Authorize. File
`%USERPROFILE%\.cloudflared\cert.pem` được tạo. **Không commit, không gửi
file này cho ai.**

## 3. Tạo Named Tunnel và gắn hostname (một lần)

```powershell
cloudflared tunnel create food-platform
# in ra Tunnel ID (UUID) và tạo %USERPROFILE%\.cloudflared\<UUID>.json

cloudflared tunnel route dns food-platform telegram.<domain>
# tạo bản ghi CNAME telegram.<domain> -> <UUID>.cfargotunnel.com
```

## 4. File cấu hình tunnel (một lần)

Tạo `%USERPROFILE%\.cloudflared\config.yml` (thay `<UUID>`, `<bạn>`, `<domain>`):

```yaml
tunnel: <UUID>
credentials-file: C:\Users\<bạn>\.cloudflared\<UUID>.json
ingress:
  - hostname: telegram.<domain>
    service: http://localhost:3901
  - service: http_status:404
```

- `credentials-file` phải là **đường dẫn tuyệt đối** (task không chạy trong
  thư mục profile của bạn).
- Quy tắc cuối `http_status:404` là bắt buộc: mọi hostname khác không đi vào FOOD.

## 5. Thử chạy tay một lần

Tắt Quick Tunnel cũ nếu còn chạy. Mở 2 cửa sổ PowerShell trong `D:\FOOD`:

```powershell
npm run platform:start                 # cửa sổ 1
cloudflared tunnel run food-platform   # cửa sổ 2
```

Cửa sổ thứ 3:

```powershell
Invoke-WebRequest -UseBasicParsing https://telegram.<domain>/api/platform/health
# StatusCode 200, nội dung {"status":"ok"}
```

Được rồi thì **dừng cả hai** (Ctrl+C) trước khi cài task ở bước 7.

## 6. Đặt webhook Telegram cố định (một lần)

Thêm vào `D:\FOOD\.env` (không commit):

```
TELEGRAM_WEBHOOK_BASE_URL=https://telegram.<domain>
```

`PLATFORM_TELEGRAM_BOT_TOKEN` và `TELEGRAM_WEBHOOK_SECRET` giữ nguyên như hiện có.

```powershell
npm run platform:telegram:webhook -- --dry-run   # chỉ kiểm tra cấu hình, không gọi Telegram
npm run platform:telegram:webhook                # setWebhook + đọc lại để xác nhận
```

Script không in token/secret, từ chối URL `trycloudflare.com`, `http://`,
localhost/IP, và giữ nguyên tin nhắn đang chờ (`drop_pending_updates: false`).
Chỉ chạy lại khi đổi hostname hoặc đổi `TELEGRAM_WEBHOOK_SECRET`.

Kiểm tra bất cứ lúc nào (không thay đổi gì):

```powershell
npm run platform:telegram:webhook -- --check
```

Telegram không trả lại secret, nên secret chỉ được chứng minh bằng một lần
giao tin thật: gửi tin cho bot rồi chạy `--check`; secret sai hiện ra là lỗi
`401` ở dòng *Last delivery error*.

## 7. Cài tự khởi động (một lần)

PowerShell **Run as Administrator**:

```powershell
cd D:\FOOD
powershell -ExecutionPolicy Bypass -File scripts\windows\install-startup.ps1 -StartNow
```

Script kiểm tra `node`, `cloudflared`, `.env`, `config.yml` (có `tunnel:`,
`credentials-file` tuyệt đối và tồn tại, ingress tới `localhost:3901`, không
phải Quick Tunnel) **trước** khi tạo task. Tạo 2 task:

| Task | Chạy | Log |
|---|---|---|
| `\FOOD\FOOD Platform` | `node platform/server.js` trong `D:\FOOD` | `logs\platform-*.out.log`, `logs\platform-*.err.log` |
| `\FOOD\FOOD Cloudflare Tunnel` | `cloudflared tunnel --config <config.yml> run food-platform` | `logs\cloudflared.log`, `logs\tunnel-*.log` |

Tuỳ chọn: `-TunnelName <tên>` nếu tunnel không tên `food-platform`,
`-CloudflaredConfig <đường-dẫn>` nếu config.yml ở chỗ khác,
`-UsePassword` (xem Troubleshooting). Chạy lại script là cài lại (thay task cũ).

## 8. Kiểm tra

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\food-status.ps1
```

In PASS/FAIL cho: 2 task đang Running, tiến trình platform và cloudflared
(và không có bản thứ hai), port 3901, health nội bộ, health qua hostname
công khai, webhook Telegram trỏ đúng URL cố định, và log giám sát không có
`GAVE UP`. Cuối cùng gửi một tin cho bot trong nhóm và xác nhận bot trả lời.

## 9. Test khởi động lại (quan trọng nhất)

1. Khởi động lại Windows (**Restart**).
2. **Không** mở PowerShell chạy platform, **không** chạy cloudflared.
3. Chờ khoảng 1–2 phút (task chờ 30 giây sau khi khởi động).
4. Chạy `scripts\windows\food-status.ps1` → phải `ALL CHECKS PASSED`.
5. Gửi tin Telegram → bot trả lời.
6. `npm run platform:telegram:webhook -- --check` → URL `(matches)`, không có lỗi 401/530 mới.

Lặp lại một lần với **Shut down** rồi bật máy (xem Fast Startup bên dưới).
Chỉ khi cả hai lần đều đạt mới ghi nhận **WINDOWS REBOOT RECOVERY: PASS**.

## 10. Chạy / dừng bằng tay

```powershell
# chạy
Start-ScheduledTask -TaskPath "\FOOD\" -TaskName "FOOD Platform"
Start-ScheduledTask -TaskPath "\FOOD\" -TaskName "FOOD Cloudflare Tunnel"

# dừng (dừng cả task và tiến trình con)
powershell -ExecutionPolicy Bypass -File scripts\windows\stop-food.ps1
```

Khi task đang chạy, **đừng** chạy thêm `npm run platform:start`: bản thứ hai
không mở được port 3901 và sẽ thoát. Muốn chạy tay để debug thì dừng task trước.

## 11. Log

Tất cả trong `D:\FOOD\logs\` (không commit, đã có trong `.gitignore`):

- `food-supervisor.log` — mỗi lần start/thoát/khởi động lại/`GAVE UP` của cả hai tiến trình.
- `platform-<ngày-giờ>.out.log` / `.err.log` — output của platform, mỗi lần start một cặp file.
- `cloudflared.log` — log của tunnel.

Xem nhanh:

```powershell
Get-Content D:\FOOD\logs\food-supervisor.log -Tail 20
Get-ChildItem D:\FOOD\logs\platform-*.err.log | Sort-Object LastWriteTime | Select-Object -Last 1 | Get-Content -Tail 50
```

Dọn log cũ hơn 14 ngày:

```powershell
Get-ChildItem D:\FOOD\logs\*-*.log | Where-Object LastWriteTime -lt (Get-Date).AddDays(-14) | Remove-Item
```

## 12. Troubleshooting

| Triệu chứng | Nguyên nhân thường gặp | Cách xử lý |
|---|---|---|
| `--check` báo `530` | Tunnel không chạy/không kết nối | `food-status.ps1`; xem `logs\cloudflared.log` |
| `--check` báo `502` | Tunnel chạy nhưng platform không chạy | Xem `logs\platform-*.err.log` và `food-supervisor.log` |
| `--check` báo `401` | `TELEGRAM_WEBHOOK_SECRET` trong `.env` khác secret đã đăng ký | `npm run platform:telegram:webhook` rồi khởi động lại task platform |
| URL `(DOES NOT MATCH)` | Webhook còn trỏ URL cũ (VD Quick Tunnel) | `npm run platform:telegram:webhook` |
| `food-supervisor.log` có `GAVE UP` | Tiến trình chết liên tục (lỗi `.env`, port bị chiếm, config tunnel sai…) | Đọc file `.err.log`/`cloudflared.log` mới nhất, sửa lỗi, rồi `Start-ScheduledTask` lại |
| `port 3901 is already in use` | Đang có platform chạy tay | Dừng bản chạy tay hoặc chạy `stop-food.ps1` |
| Task không chạy lúc khởi động, *Last Run Result* báo lỗi đăng nhập | Chế độ S4U bị chính sách máy chặn | Cài lại với `-UsePassword` (mật khẩu Windows do Task Scheduler lưu, không phải FOOD) |
| Sau **Shut down** rồi bật máy, task không tự chạy cho tới khi đăng nhập | Windows **Fast Startup** | Task vẫn chạy khi bạn đăng nhập. Muốn chạy không cần đăng nhập: tắt Fast Startup (`powercfg /h off` trong PowerShell Administrator) |
| `cloudflared tunnel list` báo thiếu cert | Chưa `cloudflared tunnel login` | Bước 2 |

## 13. Gỡ tự khởi động

```powershell
# PowerShell Run as Administrator, trong D:\FOOD
powershell -ExecutionPolicy Bypass -File scripts\windows\uninstall-startup.ps1
```

Chỉ gỡ 2 task và dừng tiến trình. Giữ nguyên tunnel, bản ghi DNS, webhook
Telegram, `.env` và log. Cài lại: chạy lại bước 7.

Xoá hẳn tunnel (không làm được hoàn tác; bot sẽ ngừng nhận tin cho tới khi có
tunnel/webhook mới):

```powershell
cloudflared tunnel delete food-platform
# rồi xoá bản ghi CNAME telegram.<domain> trong dashboard Cloudflare
```

## Không làm

- Không dùng `cloudflared tunnel --url ...` (Quick Tunnel) để vận hành.
- Không đổi webhook bằng tay sau mỗi lần khởi động lại.
- Không đưa token, secret, `cert.pem`, `<UUID>.json` vào git hay vào tài liệu.
