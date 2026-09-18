# DESIGN.md — VKU AI Challenge Competition Dashboard

Nguồn yêu cầu cho giao diện trang danh sách cuộc thi (`/`). Tài liệu này mô tả **thiết kế**;
mọi quy tắc về dữ liệu và nghiệp vụ bên dưới là ràng buộc cứng, không phải gợi ý.

## 1. Mục tiêu

Thiết kế lại trang danh sách cuộc thi theo phong cách:

- Modern academic dashboard.
- Clean, sáng, rõ ràng, mang nhận diện VKU.
- Ba màu chính: xanh – đỏ – vàng.
- Ít chữ, ưu tiên hierarchy, spacing, card và icon.
- Không thiết kế kiểu poster, không glassmorphism nặng, không gradient quá nhiều.
- Không hiệu ứng phức tạp, không thêm nội dung marketing không có trong hệ thống.

## 2. Quy tắc bất biến về dữ liệu

Giữ nguyên toàn bộ: API, query, TypeScript types, authentication, permission, join logic,
invite code, search, filter, status, routing, mutation, event handler, dữ liệu cuộc thi,
số lượng cuộc thi, tên, ngày bắt đầu/kết thúc, metric, hạn mức nộp và các button/action hiện có.

- **Không tạo dữ liệu demo.** API trả 5 cuộc thi thì render đúng 5.
- Không tự tạo NLP Challenge, Computer Vision Challenge hay bất kỳ cuộc thi giả nào.
- Không hardcode số liệu thống kê.
- Không đổi logic button, không đổi route, không bỏ feature đang hoạt động.

## 3. Bảng màu VKU

Token `--vku-*` khai báo trong `frontend/src/index.css` (`:root`). Namespace `--vku-*` là bắt
buộc vì các tên trần như `--text-secondary`, `--border` đã thuộc bảng màu Stitch đơn sắc của app.

```css
/* VKU Blue */
--vku-blue-900: #082b73;
--vku-blue-800: #073b9a;
--vku-blue-700: #064fc4;
--vku-blue-600: #0969e8;
--vku-blue-500: #1677ff;
--vku-blue-100: #eaf3ff;
--vku-blue-50:  #f5f9ff;

/* VKU Red */
--vku-red-800: #b80619;
--vku-red-700: #d30b23;
--vku-red-600: #ec1631;
--vku-red-500: #f3263f;
--vku-red-100: #ffecef;
--vku-red-50:  #fff6f7;

/* VKU Yellow */
--vku-yellow-800: #b45309;  /* bổ sung: tông chữ đạt 4.5:1 trên nền vàng nhạt */
--vku-yellow-700: #e9a900;
--vku-yellow-600: #f5b800;
--vku-yellow-500: #ffc51b;
--vku-yellow-400: #ffd43b;
--vku-yellow-100: #fff5cc;
--vku-yellow-50:  #fffbeb;

/* Neutral */
--vku-ink: #0b1f44;
--vku-ink-muted: #526078;
--vku-border: #e5e7eb;
--vku-border-soft: #eef1f5;
```

Không dùng màu đen làm màu brand chính. Nút primary ưu tiên VKU Blue.

## 4. Typography

Dùng font hiện có của project (Inter self-host). Hierarchy:

| Vai trò | Cỡ | Weight |
|---|---|---|
| Page title | 28–32px | 700 |
| Section title | 22–24px | 600–700 |
| Competition title | 18–20px | 700 |
| Normal | 14–15px | 400–500 |
| Secondary | 13–14px | 400 |
| Badge | 12–13px | 500–600 |

Không dùng quá nhiều font-size.

## 5. Cấu trúc trang

```txt
NAVBAR
──────────────────────────────────────────────────────
TITLE                        STAT 1  STAT 2  STAT 3
Subtitle
──────────────────────────────────────────────────────
[ SEARCH ]  [ FILTERS ]

Danh sách cuộc thi                        Hiển thị X

┌ BLUE ┐ ┌ RED ┐ ┌ YELLOW ┐
┌ BLUE ┐ ┌ RED ┐
```

Không sidebar phải. Không block "Về VKU AI Challenge", quote, news, marketing banner hay
card thông tin bổ sung.

## 6. Navbar

Thanh ngang full-bleed nền trắng, vạch chân 1px `--vku-border-soft`, cao 64px; nội dung bên
trong chặn ở 1440px và căn giữa. Logo VKU là asset chính thức đã có ở `frontend/public/vku-logo.png`.

Mục đang mở:

```css
background: #eaf3ff;
color: #064fc4;
box-shadow: inset 0 -2px 0 #0969e8;  /* gạch chân 2px, không đổi chiều cao */
border-radius: 10px;
```

Nút đăng nhập và avatar dùng xanh VKU. Toàn bộ handler, drawer, logout, phím tắt và skip link
giữ nguyên hành vi.

## 7. Hero / page header

Panel sáng, viền mảnh, bo 14px, nền `white → --vku-blue-50`. Ba vệt chéo xanh–đỏ–vàng ở góc
phải vẽ bằng CSS (`::before` + `linear-gradient`), `pointer-events: none`, không animation,
không ảnh AI, không ảnh campus giả.

Bên trái giữ đúng text hiện có: tiêu đề `Cuộc thi`, phụ đề `Các cuộc thi bạn có thể tham gia`.
Bên phải là ba ô thống kê, giá trị lấy từ logic hiện tại — **không hardcode**.

Toolbar (§9) nằm trong cùng panel, ngăn cách bằng vạch mảnh chứ không thành băng riêng; panel
đo được 209px ở 1440px. Đây là chủ ý: vùng "tiêu đề + thống kê + tìm kiếm/lọc" đọc như một
khối điều khiển duy nhất, và vẫn giữ đúng thứ tự của §5.

## 8. Stat cards

| Ô | Nền | Viền | Màu chữ |
|---|---|---|---|
| Đang diễn ra | `#eff6ff` | `#bfdbfe` | `--vku-blue-700` |
| Đã kết thúc | `#fff1f2` | `#fecdd3` | `--vku-red-700` |
| Đã tham gia | `--vku-yellow-50` | `#fde68a` | `--vku-yellow-800` |

Bo 12px, `font-variant-numeric: tabular-nums`, không shadow mạnh. Nhãn uppercase 12px.
Ô "Đã tham gia" tiếp tục ẩn với khách.

## 9. Toolbar

Search và filter cùng hàng ở desktop, cao 44px, bo 10px, focus-visible rõ.

- Đang chọn: nền `--vku-blue-700`, chữ trắng.
- Chưa chọn: nền `--surface-container-low`, viền `--vku-border`, chữ `--text`.
- Không render sort giả: hệ thống hiện không có state/control/logic sort.
- Từ 48rem hàng toolbar giãn hết bề ngang panel: ô search chiếm phần trống, ba nút lọc giữ
  nguyên cỡ và dồn về mép phải — trùng đúng mép phải ô thống kê "Đã tham gia" ở khối trên.

## 10. Lưới cuộc thi

```css
/* >= 75rem (1200px) */
display: grid;
grid-template-columns: repeat(3, minmax(0, 1fr));
gap: 20px;
```

Base 1 cột, `>= 48rem` 2 cột, `>= 75rem` 3 cột.

## 11. Quy tắc màu theo cột (QUAN TRỌNG NHẤT)

Màu thẻ phụ thuộc **vị trí trong lưới đang render**, KHÔNG phụ thuộc trạng thái cuộc thi.

```tsx
const CARD_THEMES = ["blue", "red", "yellow"] as const;

function getCardTheme(index: number) {
  return CARD_THEMES[index % CARD_THEMES.length];
}
```

```txt
index 0 = blue    index 3 = blue
index 1 = red     index 4 = red
index 2 = yellow  index 5 = yellow
```

- Cột 1 luôn xanh, cột 2 luôn đỏ, cột 3 luôn vàng — lặp lại theo hàng.
- Cuộc thi `status = closed` nằm ở cột 2 **vẫn giữ nguyên thẻ đỏ**; chỉ status badge chuyển xám.
- Không có card nào chuyển xám/chuyển màu vì status.
- Theme tính trên mảng `filtered` đang render, nên sau search/filter card đầu tiên trở lại xanh.

## 12. Card cuộc thi

```css
min-height: 300px;
height: 100%;
display: flex;
flex-direction: column;
overflow: hidden;
background: white;
border-radius: 12–14px;
```

- Header full-bleed cao ~56px: tên cuộc thi + status badge. Nền gradient nhẹ cùng tông cột.
- Header vàng dùng chữ `--vku-ink` để đảm bảo contrast, không dùng chữ trắng.
- Body padding 16px: chip tham gia/đếm ngược → mô tả (clamp 2 dòng) → ngày → hai mini-box
  metric & hạn mức nền `#f8fafc`, viền `#e8edf3`, bo 8px.
- Footer `margin-top: auto`, viền trên mảnh, action căn đáy. Nút cao 40px, bo 8px.
- Nút primary theo màu cột; `btn-outline` theo màu cột.
- Text và action của button giữ nguyên theo logic hiện tại.
- Thẻ đã tham gia chỉ hiện "Đã tham gia" + "Vào cuộc thi". Nút `btn-danger-ghost` "Rời cuộc thi"
  **không đặt trong danh sách** — `JoinControl` nhận `showLeave={false}`; thao tác rời màu đỏ
  vẫn nằm ở trang chi tiết cuộc thi và mở modal xác nhận danger.

Hover: dịch lên 2px + shadow nhẹ, 180–220ms. Chỉ bật trong
`@media (prefers-reduced-motion: no-preference)`.

## 13. Status badge

Status badge **không** ảnh hưởng tới màu theme của thẻ.

| Trạng thái | Màu |
|---|---|
| Đang diễn ra | nền `#d1fae5`, chữ `#047857` |
| Đã kết thúc | nền `#f1f5f9`, chữ `#475569` |
| Draft/scheduled | semantic warning hiện có |

Badge nằm trên dải header màu nên phải đục hoàn toàn. Trạng thái luôn có nhãn chữ, không chỉ
dựa vào màu.

## 14. Khoảng trống trong lưới

Có 5 cuộc thi thì render đúng 5 card; ô thứ 6 của hàng hai để trống. Không tạo card giả để lấp.

## 15. Responsive

| Bề rộng | Cột |
|---|---|
| `< 768px` | 1 |
| `>= 768px` | 2 |
| `>= 1200px` | 3 |

Trần nội dung 1440px, chỉ áp cho route `/` (`.app-main-dashboard`). Các màn khác giữ 1280px.

## 16. Spacing, radius, icon

- Spacing chỉ dùng thang 4/8/12/16/20/24/32.
- Radius: control 8–10px, card 12–14px, stat card 12px, pill 9999px.
- Icon là SVG inline theo convention sẵn có của repo (`aria-hidden="true" focusable="false"`);
  không thêm icon package. Không dùng emoji trong UI production.

## 17. Accessibility

- Button có `focus-visible`; input có `aria-label`; filter giữ `aria-pressed`.
- Contrast hợp lý (chữ thường ≥ 4.5:1).
- Không chỉ dùng màu để biểu diễn trạng thái.
- Item click được có `cursor: pointer`; không bỏ outline mà không có thay thế.
- Touch target chính ≥ 44px trên màn nhỏ.
- Một `h1`, section title `h2`, tiêu đề thẻ `h3`.

## 18. Hạn chế animation

Chỉ dùng hover, focus, translate nhỏ, chuyển màu, chuyển shadow. Không parallax, animated
background, particles, moving gradients, 3D hay entrance animation lớn. Tôn trọng
`prefers-reduced-motion`.

## 19. Không làm

Không rewrite business logic, API, route, database hay schema. Không mock data, không cuộc thi
giả, không hardcode dữ liệu, không tự thêm slogan, block About VKU, quote, news, marketing,
sidebar phải hay ảnh AI-generated. Không cài thêm UI framework/dependency.

## 20. Ghi chú riêng của repository

Các điểm dưới đây điều chỉnh contract cho đúng với code hiện tại — phần còn lại giữ nguyên.

- **CSS thuần, không Tailwind.** Toàn bộ style nằm ở `frontend/src/index.css`; các đoạn
  `className` Tailwind trong contract gốc được chuyển thành CSS thường. Không thêm Tailwind,
  CSS Module hay CSS-in-JS.
- **Icon là SVG inline.** Repo không dùng Lucide/Heroicons; mọi icon trong contract được vẽ
  bằng component SVG nội bộ theo convention `aria-hidden="true" focusable="false"`.
- **Sort không tồn tại.** Repo hiện không có state, control hay logic sort nào. Thêm sort sẽ
  đổi thứ tự dữ liệu API trả về, tức đổi business behavior — nên không làm.
- **Logo chính thức đã có.** `frontend/public/vku-logo.png` do người dùng cung cấp, đã được
  `BrandMark` trong `frontend/src/App.tsx` dùng. Không tạo hay thay asset mới.
- **Light mode only.** `color-scheme: light` được khoá ở `:root`; không thêm
  `prefers-color-scheme: dark`.
- **`--vku-yellow-800` là token bổ sung** so với bảng màu gốc, thêm để có tông vàng đạt
  contrast 4.5:1 khi làm màu chữ. Không thay thế token nào của contract.
- **Trần rộng 1440px chỉ áp cho `/`** qua class `.app-main-dashboard`, không đổi `--container`
  toàn cục, để các màn admin/auth/chi tiết giữ nguyên bố cục.
