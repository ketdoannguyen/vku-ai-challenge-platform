# Design system hiện tại — VKU AI Challenge

**Phạm vi:** Giao diện web VKU AI Challenge đang được triển khai trong `frontend/src/index.css`, đối chiếu với các component ở `frontend/src/`. Đây là bản ghi **hiện trạng trong mã**, không phải bộ quy chuẩn nhận diện chính thức của trường VKU hay đề xuất thiết kế mới.

**Cập nhật:** 2026-10-07.

## 1. Nhận diện thị giác

VKU AI Challenge dùng nền sáng, bề mặt trắng, chữ xanh navy và bộ ba màu **xanh dương – đỏ – vàng**. Xanh dương là màu hành động mặc định; đỏ và vàng tạo điểm nhấn hoặc thể hiện ngữ cảnh. Dấu hiệu ba màu xuất hiện dưới dạng ba vạch ngắn và họa tiết ở góc panel tiêu đề. Giao diện được khóa ở chế độ sáng. Nguồn: `frontend/src/index.css:68-70`, `frontend/src/index.css:923-946`, `frontend/src/index.css:955-985`.

Logo sử dụng tệp `frontend/public/vku-logo.png`; trên thanh điều hướng, logo cao 30px và đi cùng tên “AI Challenge”. Nguồn: `frontend/src/App.tsx:29-39`, `frontend/src/index.css:513-520`.

## 2. Màu sắc và token

| Vai trò | Token | Giá trị hiện tại |
|---|---|---|
| Xanh thương hiệu — hành động chính | `--vku-blue-700` | `#064fc4` |
| Xanh thương hiệu — điểm nhấn | `--vku-blue-600` | `#0969e8` |
| Xanh nhạt | `--vku-blue-100` | `#eaf3ff` |
| Đỏ thương hiệu | `--vku-red-600` | `#ec1631` |
| Đỏ đậm | `--vku-red-700` | `#d30b23` |
| Vàng thương hiệu | `--vku-yellow-500` | `#ffc51b` |
| Vàng đậm dùng cho chữ | `--vku-yellow-800` | `#b45309` |
| Nền trang | `--bg` | `#f7f9fc` |
| Bề mặt | `--surface` | `#ffffff` |
| Chữ chính | `--text` | `#0b1f44` |
| Chữ phụ | `--text-muted` | `#526078` |
| Viền | `--vku-border` | `#dfe5ec` |

Các thang xanh, đỏ và vàng đầy đủ nằm tại `frontend/src/index.css:102-132`; token theo vai trò như `--accent`, `--success`, `--warning` và `--danger` nằm tại `frontend/src/index.css:134-172`. **Màu chủ đạo của CTA là xanh VKU, không phải màu đen** (`frontend/src/index.css:147-152`).

## 3. Chữ, khoảng cách và hình khối

**Font giao diện:** Inter tự lưu trữ, hỗ trợ tiếng Việt. **Font dữ liệu kỹ thuật:** JetBrains Mono. `--font-display` cũng trỏ về Inter, không có font tiêu đề riêng. Nguồn: `frontend/src/index.css:8-63`, `frontend/src/index.css:191-195`.

### Cỡ chữ đang dùng

Các giá trị px dưới đây quy đổi từ token CSS theo `1rem = 16px`. Cột desktop chỉ thay đổi ở các tiêu đề H1–H3, từ breakpoint 48rem (768px).

| Cấp chữ / mục đích | Token hoặc quy tắc | Màn nhỏ (< 768px) | Desktop (≥ 768px) | Độ đậm / giãn dòng |
|---|---|---:|---:|---|
| H1 — tiêu đề trang | `--text-h1`, `--text-h1-desktop` | **28px** (`1.75rem`) | **32px** (`2rem`) | 600; line-height 1.25 |
| H2 — tiêu đề khu vực | `--text-h2`, `--text-h2-desktop` | **22px** (`1.375rem`) | **24px** (`1.5rem`) | 600; line-height 1.3 |
| H3 — tiêu đề nhóm/card | `--text-h3`, `--text-h3-desktop` | **18px** (`1.125rem`) | **20px** (`1.25rem`) | 600; line-height 1.4 |
| H4–H6 | `--text-h4` | **16px** (`1rem`) | **16px** (`1rem`) | 600; line-height 1.4 |
| Text chính — nội dung, đoạn văn | `--text-body` | **16px** (`1rem`) | **16px** (`1rem`) | 400 ở body; line-height 1.65 |
| Text nhỏ — phụ đề ngắn, mô tả, note phổ biến | `--text-body-sm` | **14px** (`0.875rem`) | **14px** (`0.875rem`) | Kế thừa; line-height 1.5 khi áp dụng token tương ứng |
| Text của nút, ô nhập, nhãn trường | `--text-control` | **14px** (`0.875rem`) | **14px** (`0.875rem`) | Tùy component; token line-height 1.4 |
| Label/badge — nhãn ngắn, tiêu đề cột bảng | `--text-label` | **12px** (`0.75rem`) | **12px** (`0.75rem`) | Thường 600 ở badge/bảng; token line-height 1.3 |
| Text kỹ thuật / mã | `--text-code` | **13px** (`0.8125rem`) | **13px** (`0.8125rem`) | Font JetBrains Mono; token line-height 1.5 |

Nguồn token: `frontend/src/index.css:191-224`; quy tắc heading mặc định và breakpoint: `frontend/src/index.css:345-380`, `frontend/src/index.css:411-423`. Tiêu đề `.page-hero-title` dùng cùng cỡ H1 nhưng **độ đậm 700**, thay vì 600 của heading mặc định (`frontend/src/index.css:1037-1045`, `frontend/src/index.css:1082-1084`).

**Note không có token cỡ chữ riêng.** Tùy ngữ cảnh, `.modal-note`, `.about-note` và `.support-contact-note` dùng **14px** (`--text-body-sm`); `.agg-note` dùng **13px** trực tiếp; `.admin-detail-fact-note` dùng **11px** trực tiếp. Không nên hiểu mọi note đều là 14px. Nguồn: `frontend/src/index.css:1708-1712`, `frontend/src/index.css:7198-7204`, `frontend/src/index.css:13658-13666`, `frontend/src/index.css:14025-14036`, `frontend/src/index.css:14415-14425`.

- **Thang khoảng cách có token:** 4, 8, 16, 24, 32px. Các khoảng cách khác như 12 và 20px vẫn được viết trực tiếp tại nơi sử dụng. Nguồn: `frontend/src/index.css:235-242`.
- **Bo góc:** 2, 4, 6, 8, 12, 14px; dạng viên thuốc 999px. Card thường dùng 12–14px, control thường dùng 8px. Nguồn: `frontend/src/index.css:259-266`.
- **Đổ bóng:** bóng card nhẹ; bóng modal rõ hơn. Chuyển trạng thái cơ bản 150–200ms. Nguồn: `frontend/src/index.css:268-279`.

## 4. Bố cục và thành phần

| Thành phần | Quy cách đang dùng |
|---|---|
| **Thanh điều hướng** | Cố định phía trên, cao 64px, nền trắng; nội dung giới hạn 1440px. Mục đang mở có nền xanh nhạt và gạch chân xanh 2px. `frontend/src/index.css:245-257`, `frontend/src/index.css:452-475`, `frontend/src/index.css:530-554` |
| **Panel tiêu đề trang** | Nền chuyển nhẹ từ trắng sang xanh rất nhạt, viền mảnh, bo 14px; họa tiết xanh–đỏ–vàng ở góc phải. `frontend/src/index.css:948-985` |
| **Card cơ bản** | Nền trắng, viền 1px, bo 12px, bóng nhẹ, padding 24px. `frontend/src/index.css:913-921` |
| **Nút chính** | Cao 40px, bo 8px, nền và viền theo `--accent`; có các biến thể secondary, outline, ghost và danger. Nút nhỏ cao 32px. `frontend/src/index.css:1093-1204` |
| **Ô nhập liệu** | Cao 44px, bo 8px; khi focus có viền xanh và vòng sáng 3px. `frontend/src/index.css:1206-1234` |
| **Nhãn trạng thái** | Dạng pill, chữ 12px, có các sắc thái thành công, cảnh báo, nguy hiểm, đóng và trung tính. Trạng thái có chữ, không chỉ biểu thị bằng màu. `frontend/src/index.css:1261-1300` |
| **Bảng** | Nền trắng, viền và bóng nhẹ; vùng chứa cuộn ngang khi cần. Tiêu đề cột dùng chữ 12px in hoa. `frontend/src/index.css:1511-1563` |
| **Hộp thoại** | Nền phủ tối có làm mờ; hộp thoại trắng bo 14px, rộng tối đa 500px hoặc 640px. `frontend/src/index.css:1617-1641`, `frontend/src/index.css:1714` |

Ở **lưới cuộc thi**, card lấy màu theo **vị trí hiển thị**, lặp xanh → đỏ → vàng; màu này không biểu thị trạng thái cuộc thi. Trạng thái được thể hiện riêng bằng badge. Nguồn: `frontend/src/index.css:2019-2072`.

## 5. Responsive và khả năng tiếp cận

- Nội dung thông thường giới hạn **1280px**; một số trang cần không gian ngang dùng **1440px**. Nguồn: `frontend/src/index.css:244-257`, `frontend/src/App.tsx:443-469`.
- Lưới cuộc thi có **1 cột** trên màn hẹp, **2 cột từ 768px**, **3 cột từ 1200px**. Nguồn: `frontend/src/index.css:2013-2017`, `frontend/src/index.css:12146-12148`, `frontend/src/index.css:12185-12188`.
- Từ **768px**, thanh điều hướng đầy đủ xuất hiện thay cho nút mở menu. Nguồn: `frontend/src/index.css:12089-12095`.
- Có liên kết bỏ qua điều hướng, dấu hiệu focus cho bàn phím và chế độ giảm chuyển động. Modal giữ focus trong hộp thoại và trả focus khi đóng. Nguồn: `frontend/src/App.tsx:350-354`, `frontend/src/index.css:12023-12058`, `frontend/src/components/Modal.tsx:39-89`.

## 6. Mức độ thống nhất hiện tại

VKU đã có **bảng màu, token nền tảng và một số mẫu dùng chung**, nổi bật là panel tiêu đề trang. Tuy vậy, đây **chưa phải một thư viện component thống nhất**: nhiều trang có cách triển khai card, bảng, badge và trạng thái riêng thay vì dùng chung hoàn toàn các lớp cơ bản. Tài liệu `DESIGN.md` chủ yếu quy định trang danh sách cuộc thi (`/`), nên khi mô tả toàn website, **CSS và component hiện tại là căn cứ trực tiếp**. Chẳng hạn, hai giá trị viền trong `DESIGN.md:63-64` khác giá trị đang triển khai tại `frontend/src/index.css:129-132`.
