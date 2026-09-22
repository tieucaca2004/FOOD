# Dữ liệu menu cần chủ quán bổ sung

`products.json` hiện chỉ có **4 món đã được xác nhận** trong yêu cầu ban đầu
(Hủ Tiếu Xào Bò, Hải Sản, Thập Cẩm, Đặc Biệt). Hệ thống **không tự bịa** thêm
món, giá, hay khuyến mãi nào khác.

Chủ quán A Tiểu cần bổ sung (nếu có) trước khi go-live:

- [ ] Món nước uống (nếu bán kèm)
- [ ] Món khai vị/phụ khác ngoài hủ tiếu xào
- [ ] Size/topping thêm (dùng bảng `product_options`, có `price_delta`)
- [ ] Phí giao hàng thật (`business_settings.delivery_fee`, hiện seed placeholder
      15.000đ — **cần xác nhận số thật**)
- [ ] Giờ mở cửa thật (`business_settings.opening_hours`, hiện seed placeholder
      "08:00 - 21:00 hằng ngày" — **cần xác nhận**)
- [ ] Địa chỉ quán thật (`business_settings.store_address` — hiện đang trống,
      bot sẽ trả lời "chưa có thông tin" cho tới khi được điền)
- [ ] Số điện thoại quán (`business_settings.store_phone`)
- [ ] Khuyến mãi đang chạy (bảng `promotions` — hiện trống, bot sẽ không nói có
      khuyến mãi nếu bảng này trống)

## Cách thêm món mới

Thêm entry vào `data/seed/products.json` theo format:

```json
{
  "sku": "MA-DUY-NHAT",
  "name": "Tên món hiển thị",
  "category": "Tên category (phải khớp với categories.json)",
  "description": "Mô tả ngắn",
  "price": 0,
  "available": true,
  "sort_order": 5,
  "keywords": ["từ khoá để khách gõ tắt vẫn nhận diện được"]
}
```

Chạy lại `npm run seed` — script upsert theo `sku`, an toàn chạy nhiều lần
(idempotent), không tạo trùng, không xoá dữ liệu order/cart hiện có.
