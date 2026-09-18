# ADMIN_COMPETITIONS_DESIGN.md - Quản trị → Quản lý cuộc thi

Tài liệu này mở rộng `DESIGN.md` cho đúng một màn: `/admin/competitions`
(alias cũ `/admin`). Token, typography, spacing, radius, icon, light-mode và
các quy tắc bất biến về dữ liệu của `DESIGN.md` vẫn áp dụng nguyên vẹn; file
này chỉ chốt phần bố cục và trình bày riêng của màn quản trị.

Không mô tả lại nghiệp vụ: nguồn sự thật cho dữ liệu, mutation, status và
permission là code hiện tại, không phải tài liệu này.

## 1. Nguyên tắc bất biến

Đây là redesign UI/UX. Không thay đổi:

- API, endpoint, request payload, response type, TypeScript interface.
- Authentication, authorization, admin permission, `RequireAdmin`.
- Create / update / publish / close / clone / delete logic và validation.
- Search, filter, refresh, pagination, query param, route.
- Thứ tự, quyền và điều kiện hiển thị của từng mục trong menu thao tác.
- Business copy: `toàn hệ thống`, `Chỉ admin thấy`, `Chỉ admin thấy`,
  `Chỉ số đánh giá`, nhãn status, nhãn join mode, định dạng ngày.

Không hardcode số liệu. Bốn ô thống kê lấy từ chính mảng `competitions` mà
`GET /admin/competitions` trả về, không có endpoint thống kê nào được thêm.

Không bịa dữ liệu: không competition giả, không member giả, không metric giả,
không nhãn nghiệp vụ mới. Mockup chỉ là tham chiếu bố cục - text trong mockup
không phải dữ liệu thật.

Không thêm dependency, không Tailwind, không CSS Module, không icon package.
Icon là SVG inline theo convention `aria-hidden="true" focusable="false"`.

## 2. Cấu trúc trang

```txt
HEADER      Quản lý cuộc thi                      [+ Tạo cuộc thi]
            Tạo, chỉnh sửa, publish/close và clone cuộc thi
            ▬▬▬ xanh / đỏ / vàng

STATS       [ Tổng ] [ Đang diễn ra ] [ Bản nháp ] [ Đã kết thúc ]

TOOLBAR     [Tất cả][Bản nháp][Đang diễn ra][Đã kết thúc]
                                  [ Tìm kiếm... ] [ Làm mới ]

TABLE       ▮ Danh sách cuộc thi                        6 cuộc thi
            TÊN SLUG TRẠNG THÁI THỜI GIAN METRIC
            THÀNH VIÊN BÀI NỘP THAO TÁC
            Phân trang
```

Không sidebar phải, không marketing block, không slogan, không ảnh giả.

## 3. Trần rộng

Màn danh sách quản trị cần đủ chỗ cho bảng 8 cột nên dùng trần 1440px, áp bằng
một class shell riêng cho đúng hai route `/admin/competitions` và `/admin` -
cùng cách `DESIGN.md` §15 đã làm cho `/` bằng `.app-main-dashboard`.

`/admin/competitions/:id` và các màn admin khác vẫn giữ `--container` 1280px.

## 4. Header

Panel sáng, viền mảnh, bo 14px, nền `white → --vku-blue-50`, ba vệt chéo
xanh–đỏ–vàng ở góc phải vẽ bằng CSS (`::before` + `linear-gradient`,
`pointer-events: none`, không animation) - cùng công thức với `.dash-hero`.

Khác dashboard công khai ở chỗ: header quản trị **thấp và gọn**, không phải
hero. Nội dung giữ đúng text hiện có, không thêm câu mô tả mới.

- `h1`: `Quản lý cuộc thi`
- phụ đề: `Tạo, chỉnh sửa, publish/close và clone cuộc thi`
- dưới phụ đề: ba line ngắn xanh–đỏ–vàng, thuần decorative, `aria-hidden`.
- CTA: `+ Tạo cuộc thi`, native `<button type="button">`.

CTA dùng VKU Blue, không dùng đen: nền `--vku-blue-700`, hover
`--vku-blue-800`, chữ trắng, cao 44–46px, bo 9–10px.

## 5. Bốn ô thống kê

Bốn card rời (không phải một dải chung ngăn bằng đường kẻ). Màu **chỉ để nhận
diện thương hiệu**, không phải trạng thái và không tham gia business logic.

| Ô | Tone | Nền | Viền | Chữ |
|---|---|---|---|---|
| Tổng cuộc thi | blue | `--vku-blue-50` | `#cfe1ff` | `--vku-blue-700` |
| Đang diễn ra | red | `#fff7f8` | `#ffd0d6` | `--vku-red-700` |
| Bản nháp | yellow | `--vku-yellow-50` | `#f6d987` | `--vku-yellow-800` |
| Đã kết thúc | neutral | `white → #f5f7fa` | `--vku-border` | `--vku-ink` |

- Text phụ giữ nguyên business copy hiện có, không đổi.
- Số dùng `font-variant-numeric: tabular-nums`, không hardcode.
- Icon nằm trong box tint nhỏ, decorative, không có icon nền lớn.
- Text trên nền vàng chỉ dùng `--vku-yellow-800` (tông vàng duy nhất đủ 4.5:1).

## 6. Toolbar

Một surface trắng, viền nhẹ, bo 14px, padding 12–16px.

- Filter bên trái, search + refresh bên phải ở desktop.
- Filter là hàng nút rời, cao 44px, bo 10px.
  - chưa chọn: `--surface-container-low` + `--vku-border`, chữ `--text`.
  - hover: tint xanh nhạt.
  - `aria-pressed="true"`: nền `--vku-blue-700`, chữ trắng. **Không dùng đen.**
- Search cao 44px, bo 9–10px, focus có border xanh + ring - không bỏ outline
  mà không có thay thế.
- Refresh là nút secondary, giữ spinner và nhãn `Đang tải... / Làm mới`.

Nhãn filter vẫn là `{label} ({count})` với count lấy từ dữ liệu thật.

## 7. Bảng

Card trắng, viền `--vku-border`, bo 14px, `overflow: hidden`, shadow rất nhẹ.

- Tiêu đề khối `h2 Danh sách cuộc thi` kèm count ở mép phải; cạnh tiêu đề có
  accent dọc xanh–đỏ–vàng ngắn, thuần decorative.
- Giữ **đúng 8 cột** và đúng thứ tự: Tên, Slug, Trạng thái, Thời gian, Metric,
  Thành viên, Bài nộp, Thao tác. Không xoá cột, không đổi thứ tự.
- `thead`: nền sáng rất nhạt, chữ 12px uppercase màu muted.
- Row: nền trắng, viền dưới `--vku-border-soft`, hover tint xanh rất nhạt.
  Không biến mỗi row thành card riêng.
- Giữ `table-layout: fixed`, `min-width` và tỉ lệ `colgroup` hiện có; bảng rộng
  chỉ cuộn ngang bên trong `.ac-table-scroll`, không đẩy cả trang.

### 7.1 Accent theo hàng (decorative)

Một ô vuông 40–44px chứa **một icon chung cho mọi hàng**, màu lặp theo **vị trí
trong trang đang render**: 0 = xanh, 1 = đỏ, 2 = vàng, rồi lặp lại.

```tsx
const ROW_ACCENTS = ["blue", "red", "yellow"] as const;
```

- Không đọc `status`, `join_mode` hay bất kỳ field nghiệp vụ nào để chọn màu.
- Cuộc thi `closed` nằm ở vị trí 1 vẫn giữ accent đỏ; chỉ status badge xám.
- Accent `aria-hidden`, cùng icon cho mọi hàng, không ám chỉ loại cuộc thi.
- Status vẫn là nguồn semantic duy nhất và luôn có nhãn chữ.

### 7.2 Nội dung ô

- Tên: 14px/600, link giữ nguyên route `/admin/competitions/:id`; badge join mode
  neutral, text lấy từ `JOIN_MODE_LABEL`.
- Slug: chip mono, xuống dòng an toàn. Hệ thống hiện không có copy slug nên
  không thêm.
- Trạng thái: `statusClass()` như hiện tại (published xanh, draft vàng, closed
  xám), kèm dot + chữ; draft hiện thêm `Chỉ admin thấy`.
- Thời gian: `formatLocal()` như hiện tại, hai dòng Bắt đầu / Kết thúc.
- Metric: `METRIC_LABEL` + `{quota_per_day} lượt/ngày`, không hardcode.
- Thành viên / Bài nộp: số thật, căn giữa, `0` vẫn là `0` (chỉ đổi màu muted).

## 8. Menu thao tác

Giữ nguyên hành vi, chỉ đổi trình bày.

- Trigger ba chấm: 38px desktop, tối thiểu 44px trên màn nhỏ; trắng, viền
  neutral, hover/focus tint xanh.
- Menu vẫn portal ra `document.body` + `position: fixed` vì `.ac-table-scroll`
  (`overflow-x: auto`) sẽ cắt dropdown.
- Item bình thường hover/focus tint xanh; item nguy hiểm tint đỏ.
- Không đổi: portal, logic lật lên khi chạm đáy viewport, focus item đầu,
  ArrowUp/Down/Home/End, Escape trả focus, Tab đóng, outside-click, đóng khi
  scroll/resize, `title` lý do khoá `Sửa`, và thứ tự action.

## 9. Trạng thái và phân trang

- Loading / error / no-data / filtered-empty giữ nguyên toàn bộ text hiện có;
  chỉ đổi khoảng đệm, màu và cách trình bày nút.
- Pagination giữ `PAGE_SIZE = 5`, giữ câu `Hiển thị X–Y trong số Z cuộc thi`,
  không thêm page-size selector. Trang hiện tại dùng VKU Blue.
- Toast giữ `role="status"` và nút đóng; nền đổi sang `--vku-ink`.

## 10. Responsive

| Bề rộng | Thống kê | Toolbar | Bảng |
|---|---|---|---|
| `< 40rem` | 1 cột | filter cuộn ngang nội bộ, search full width, refresh không tràn | cuộn ngang trong khung |
| `40–47.99rem` | 1 cột | xếp dọc | cuộn ngang trong khung |
| `48–74.99rem` | 2×2 | wrap thành hai hàng | cuộn ngang trong khung |
| `>= 75rem` | 4 cột | một hàng | đầy đủ |

Không bao giờ để `document.documentElement.scrollWidth > clientWidth`.

## 11. Accessibility

- Một `h1` (`Quản lý cuộc thi`), một `h2` (`Danh sách cuộc thi`).
- Giữ `section[aria-label="Tổng quan cuộc thi"]`.
- Giữ `.ac-table-scroll` là `role="region"`, `aria-label="Bảng danh sách cuộc
  thi"`, `tabIndex={0}`.
- Giữ `aria-pressed` trên filter, `aria-haspopup`/`aria-expanded` trên trigger
  menu, `aria-label="Thao tác cho {tên}"`.
- Mọi control có `focus-visible` nhìn thấy; không xoá outline mà không thay thế.
- Touch target chính ≥ 44px trên màn nhỏ.
- Không chỉ dùng màu để biểu diễn trạng thái.
- Tôn trọng `prefers-reduced-motion`.

## 12. Không làm

Không backend, không API, không route, không schema, không permission.
Không mock data, không hardcode số liệu, không đổi business copy.
Không thêm pagination, sort, filter hay action mới.
Không rewrite bảng thành card view.
Riêng `CompetitionFormModal` (dialog Tạo/Sửa cuộc thi) theo `CREATE_COMPETITION_DIALOG_DESIGN.md`; phần còn lại của `AdminCompetitionManagement.tsx` vẫn theo tài liệu này. Shared `Modal.tsx` và các confirm modal không đổi.
Không đổi `DESIGN.md` hay `--container` toàn cục.
