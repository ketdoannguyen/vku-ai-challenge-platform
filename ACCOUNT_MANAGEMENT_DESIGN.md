# ACCOUNT_MANAGEMENT_DESIGN.md — Quản trị → Quản lý tài khoản

Tài liệu này mở rộng `DESIGN.md` cho đúng một màn: `/admin/accounts`.
Token, typography, spacing, radius, icon, light-mode và các quy tắc bất biến về
dữ liệu của `DESIGN.md` vẫn áp dụng nguyên vẹn; file này chỉ chốt phần bố cục và
trình bày riêng của màn quản lý tài khoản.

Kế thừa bố cục và nhịp màu từ `ADMIN_COMPETITIONS_DESIGN.md` và
`COMPETITION_DETAIL_DESIGN.md`.

Không mô tả lại nghiệp vụ: nguồn sự thật cho dữ liệu, mutation, role, status và
permission là code hiện tại, không phải tài liệu này.

## 1. Mục tiêu

Redesign theo phong cách VKU Academic Dashboard: sáng, hiện đại, gọn, dễ scan
dữ liệu, nhiều khoảng trắng, responsive, đồng nhất với Dashboard và hai màn quản
trị cuộc thi.

Nhịp màu thương hiệu:

- Xanh (`--vku-blue-*`) là primary.
- Đỏ (`--vku-red-*`) là accent mạnh và là màu destructive.
- Vàng (`--vku-yellow-*`) là highlight.
- Xanh lá chỉ dành cho trạng thái semantic (đang hoạt động), không dùng làm màu
  thương hiệu.

Không biến giao diện thành poster, không lạm dụng gradient, không dùng màu đen
làm màu CTA chính.

## 2. Nguyên tắc bất biến

Đây là redesign UI/UX cộng thêm **một mở rộng đọc-only đã được duyệt** ở tầng
API thống kê. Không thay đổi:

- Authentication, authorization, `RequireAdmin`, role, permission.
- Account schema lưu trữ, enum role (`admin` / `participant`), field `active`.
- Create / reset password / enable-disable logic, validation, confirmation flow.
- Search (debounce, ngữ nghĩa `q`), pagination (`limit`, `offset`, `PAGE_SIZE`).
- Current-user detection: so sánh `account.id` với `auth.account.id`, không suy ra
  từ chuỗi email.
- Chặn tự vô hiệu hóa chính mình và thông báo `sr-only` kèm `aria-describedby`.
- Business copy hiện có, gồm câu mô tả dưới tiêu đề
  `Tạo, đặt lại mật khẩu, vô hiệu hóa tài khoản thí sinh/admin` và placeholder
  `Tìm theo email hoặc tên...`.

Không thêm dependency, không Tailwind, không CSS Module, không icon package. Icon
là SVG inline theo convention `aria-hidden="true" focusable="false"`.

Không bịa nội dung: không slogan, quote, footer, ảnh trường, account demo, email
demo, chart, KPI, "đăng nhập gần nhất" hay "hoạt động gần đây". Mockup chỉ là
tham chiếu bố cục — text và số trong mockup không phải dữ liệu thật.

## 3. Nguồn số liệu thống kê

Bốn ô thống kê cần số liệu **toàn hệ thống**. `GET /api/admin/accounts` trả một
page dữ liệu kèm `total` của truy vấn hiện tại, nên không thể suy ra số Admin,
Thí sinh hay số đang hoạt động từ mảng `accounts` của page đó.

Vì vậy endpoint danh sách được mở rộng **additive** bằng một object `stats`:

```json
{
  "accounts": [],
  "total": 1,
  "limit": 50,
  "offset": 0,
  "stats": { "total": 230, "admin": 8, "participant": 222, "active": 224 }
}
```

- `total` (top-level) giữ nguyên ngữ nghĩa cũ: số bản ghi **khớp `q`**, dùng cho
  tiêu đề bảng và phân trang.
- `stats.*` là số liệu **toàn hệ thống**, không phụ thuộc `q`, `limit`, `offset`.
- `stats.active` coi tài khoản legacy thiếu field `active` là đang hoạt động,
  khớp `public_account()`.
- Không có endpoint thống kê riêng; endpoint create / reset-password / patch giữ
  nguyên response.

Ràng buộc phía UI:

- Chỉ render từ `response.stats`. Không dùng `accounts.length` của page để gọi là
  tổng số.
- Không hardcode số, không tạo account giả để "cho đủ số".
- Khi chưa có dữ liệu (đang tải hoặc lỗi hẳn), hiển thị placeholder
  `aria-hidden` kèm text `sr-only` cho trình đọc màn hình — không hiện số giả.

## 4. Cấu trúc trang

```txt
HEADER   [icon] Quản lý tài khoản
                Tạo, đặt lại mật khẩu, vô hiệu hóa tài khoản thí sinh/admin
                ▬▬▬ xanh / đỏ / vàng

STATS    [ Tổng tài khoản ] [ Tài khoản Admin ] [ Tài khoản Thí sinh ] [ Đang hoạt động ]

TOOLBAR  [ 🔍 Tìm theo email hoặc tên... ]              [+ Tạo tài khoản]

TABLE    ▮ Danh sách tài khoản                         230 tài khoản
         EMAIL | TÊN | VAI TRÒ | TRẠNG THÁI | THAO TÁC
         ── phân trang (ngoài vùng cuộn ngang) ──
```

Không sidebar, không marketing block, không filter theo role/status, không nút
làm mới, không menu ba chấm, không cột phát sinh.

## 5. Trần rộng

`/admin/accounts` không nằm trong nhóm shell 1440px. Bảng chỉ có 5 cột với
`min-width: 900px` nên giữ `--container` 1280px như `ADMIN_COMPETITIONS_DESIGN.md`
§3 đã quy định cho các màn admin khác ngoài danh sách cuộc thi.

## 6. Header

Panel đầu trang theo đúng công thức `.ac-page-head`: bo `--radius-2xl`, nền
gradient trắng sang xanh nhạt, viền `--vku-border`, dải chéo xanh–đỏ–vàng ở góc
phải bằng CSS thuần (`pointer-events: none`, không animation), và
`> * { position: relative }` để nâng nội dung lên trên lớp trang trí.

- Icon container 60×60, `--radius-2xl`, nền xanh nhạt, viền xanh, glyph xanh VKU.
  Icon decorative, `aria-hidden`.
- Tiêu đề `Quản lý tài khoản` dùng scale `--text-h1` / `--text-h1-desktop`.
- Subtitle giữ nguyên câu nghiệp vụ hiện có.
- Ba thanh accent xanh/đỏ/vàng dưới subtitle, `aria-hidden="true"`.

CTA `Tạo tài khoản` nằm ở toolbar, không nằm ở header.

## 7. Bốn ô thống kê

Grid 4 cột, `gap` theo `--space-md`/20px; tablet 2×2; mobile 1 cột (2 cột khi đủ
rộng). Card theo công thức `.ac-stat-card`: `min-height` khoảng 126–136px,
`padding` 20–22px, `--radius-2xl`, icon box 40×40 bo 10px, số `tabular-nums`.

| Ô | Tone | Viền trên | Ghi chú |
|---|---|---|---|
| Tổng tài khoản | Xanh | `--vku-blue-600` | Nền xanh nhạt, chữ `--vku-blue-700` |
| Tài khoản Admin | Đỏ | `--vku-red-600` | Nền hồng nhạt, chữ `--vku-red-700` |
| Tài khoản Thí sinh | Vàng | `--vku-yellow-600` | Chữ bắt buộc `--vku-yellow-800` để đủ 4.5:1 |
| Đang hoạt động | Xanh lá semantic | `--vku-blue-600` | Nền/chữ xanh lá; viền trên giữ xanh VKU để nhận diện thương hiệu |

Màu card chỉ để nhận diện thương hiệu và phân nhóm, không dùng để suy ra trạng
thái hay quyền thao tác. Mỗi card luôn có label bằng chữ nên màu không phải
nguồn thông tin duy nhất.

## 8. Toolbar

Card trắng, `--radius-2xl`, viền `--vku-border`, shadow nhẹ, `padding` 12–16px.
Desktop là một hàng: search bên trái (rộng 430–520px), CTA bên phải.

Search giữ nguyên `aria-label="Tìm tài khoản"`, placeholder, state và debounce
hiện tại. Focus dùng viền xanh + ring, không bỏ focus ring. Chỉ báo
`Đang cập nhật…` giữ `role="status"`.

CTA `Tạo tài khoản` dùng xanh VKU (`--vku-blue-700`), cao 46px, bo 9px. Dấu `+`
là phần tử decorative `aria-hidden` để accessible name vẫn đúng là
`Tạo tài khoản`.

## 9. Bảng tài khoản

Card trắng, `--radius-2xl`, viền nhẹ, `border-top` 3px xanh VKU, shadow nhẹ.
Header card có vạch accent dọc ba màu và tiêu đề `Danh sách tài khoản`, bên phải
là số kết quả hiện tại (top-level `total`).

Giữ đúng năm cột và semantic `<th scope="col">`:

```txt
EMAIL | TÊN | VAI TRÒ | TRẠNG THÁI | THAO TÁC
```

Không thêm ngày tạo, đăng nhập gần nhất, số cuộc thi đã tham gia hay hoạt động.
Không ẩn cột ở bất kỳ breakpoint nào — mobile cuộn ngang trong vùng cuộn.

Vùng cuộn giữ nguyên `role="region"`, `aria-label="Bảng tài khoản"`,
`tabIndex={0}`, `aria-busy`, và `position: relative` để phần tử `.sr-only` trong
ô không thoát khỏi vùng cuộn gây tràn trang. Vùng này phải có focus-visible ring.

### 9.1 Ô Email

Email rõ, medium weight. Badge `Bạn` chỉ hiện khi `isCurrent` xác định từ
`account.id`, màu xanh VKU.

### 9.2 Ô Vai trò

- Admin: badge xanh VKU.
- Thí sinh: badge neutral xám nhạt.
- Dùng class riêng của trang, không sửa `.role-badge` / `.badge-muted` dùng chung.

### 9.3 Ô Trạng thái

- Hoạt động: badge xanh lá + dot + chữ `Hoạt động`.
- Vô hiệu: badge xám + dot + chữ `Vô hiệu`.

Trạng thái luôn có chữ, không chỉ thể hiện bằng màu.

### 9.4 Ô Thao tác

```txt
[ Đặt lại MK ]  [ Vô hiệu hóa ]   hoặc   [ Đặt lại MK ]  [ Kích hoạt ]
```

- `Đặt lại MK`: outline neutral/xanh, không destructive.
- `Vô hiệu hóa`: đỏ (destructive).
- `Kích hoạt`: neutral/xanh.
- Giữ nguyên label, `disabled`, `aria-describedby`, handler và ConfirmModal.
- Khi bị chặn tự vô hiệu hóa: button vẫn hiển thị nhưng disabled, kèm lý do
  `sr-only`. Không xoá button, không enable chỉ vì mockup.

## 10. Hộp thoại

Tiếp tục dùng `Modal variant="account-form"` và `ConfirmModal` hiện có; chỉ
restyle trong scope `.modal-account-form` / `.account-form-*`.

- Create: header accent xanh, submit xanh, cancel neutral, lỗi validation đỏ.
- Reset password: submit xanh vì đây là thao tác quản trị bình thường, không phải
  hành động phá huỷ.
- Disable: dùng `danger` nên confirm đỏ; cancel neutral.
- Enable: confirm thường, không dùng đỏ.

Không đổi field, id, label, `required`, `minLength`, `autoComplete`, thứ tự field,
cách map `ACCOUNT_EXISTS`, security note, password toggle hay focus management.

## 11. Phân trang

Giữ nguyên hành vi: chỉ hiện khi `total > PAGE_SIZE`, `aria-disabled` (không dùng
`disabled`) kèm guard trong `onClick`, math `shownFrom` / `shownTo` / offset ± 50,
và pager nằm **ngoài** vùng cuộn ngang.

Trình bày trong footer của table card, tông xanh VKU cho trạng thái active/hover,
focus visible đầy đủ.

## 12. Responsive

- Desktop ≥1200px: stats 4 cột, toolbar một hàng, bảng full card.
- Tablet 768–1199px: stats 2×2, toolbar có thể wrap, bảng cuộn ngang nội bộ.
- Mobile <768px: header reflow, stats 1–2 cột, search và CTA full width, bảng vẫn
  đủ 5 cột và cuộn ngang, phân trang stack không làm tràn body, modal actions
  full width.

Không có dark mode: dự án khoá `color-scheme: light`.

## 13. Accessibility

- Search có accessible label; CTA create đúng `type="button"`.
- Button icon-only (password toggle) có `aria-label`.
- Vùng cuộn bảng focus được bằng bàn phím và có focus-visible ring.
- Trạng thái và vai trò luôn có text, không chỉ màu.
- Bảng dùng `<th scope="col">`; dialog giữ focus trap, Escape và focus restore
  của `Modal`.
- Thông báo thành công giữ `role="status"`; lỗi giữ `role="alert"`.

## 14. Không làm

Không: sửa auth/role/permission/enum/account schema, đổi mutation, hardcode
account hay số liệu, tạo user/email demo, fake current user, thêm chart, KPI
không nguồn, pagination khi nguồn không có, menu action không tồn tại, đổi
button behavior, dùng đen làm primary, hay cài UI/icon library mới.

## 15. Acceptance criteria

- [x] Đồng nhất ngôn ngữ thiết kế với Dashboard, Quản lý cuộc thi, Chi tiết cuộc thi.
- [x] Xanh/đỏ/vàng VKU rõ nhưng không lạm dụng; primary CTA là xanh.
- [x] Tổng = xanh, Admin = đỏ, Thí sinh = vàng, Hoạt động = xanh lá semantic.
- [x] Tạo = xanh, Đặt lại MK = neutral/xanh, Vô hiệu hóa = đỏ.
- [x] Badge Admin = xanh, Thí sinh = neutral, Hoạt động = xanh lá, `Bạn` = xanh.
- [x] Số liệu lấy từ `stats` toàn hệ thống, không từ page hiện tại.
- [x] Không hardcode dữ liệu, không fake text/ảnh/số liệu.
- [x] Search, create, reset password, disable/enable và chặn tự vô hiệu hóa giữ nguyên.
- [x] Auth, permission, route guard không đổi.
- [x] Responsive, không tràn body; bảng giữ đủ cột.
- [x] TypeScript, lint và production build pass.

Bằng chứng: `backend/tests/test_admin_accounts.py` (17 test, trong đó 4 test
`stats`) và `frontend/src/pages/AdminAccountsPage.test.tsx` (14 test). Kiểm tra
trình duyệt bằng Playwright ở 375/640/768/1024/1200/1440 px với API được mock:
85 assertion bố cục/màu/accessibility và 21 assertion hộp thoại (focus trap,
Escape trả focus, validation, không phát mutation khi nút bị khoá). Ánh xạ test
chi tiết nằm ở `docs/TEST_MATRIX.md`.
