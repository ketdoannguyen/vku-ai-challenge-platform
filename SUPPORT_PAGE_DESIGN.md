# SUPPORT_PAGE_DESIGN.md

# VKU AI Challenge — Hỗ trợ & Liên hệ

> Design specification cho trang:
>
> `Hỗ trợ & Liên hệ` (`/ho-tro`)
>
> File này kế thừa:
>
> - `VKU_GLOBAL_DESIGN.md`
> - `DESIGN.md`
> - các design specification hiện có của VKU AI Challenge
>
> Đây là UI/UX redesign.
> Không thay đổi dữ liệu, nội dung nghiệp vụ hoặc logic hiện tại.

## 1. MỤC TIÊU

Thiết kế lại trang Hỗ trợ & Liên hệ theo phong cách:

- Modern academic
- VKU-branded
- Clean
- Sáng
- Dễ đọc
- Dễ tìm thông tin
- Ít clutter
- Responsive
- Phù hợp React + TypeScript / TSX

Trang phải đồng nhất trực quan với:

- Cuộc thi
- Quản lý cuộc thi
- Chi tiết cuộc thi
- Tài khoản

Không được có cảm giác đây là một trang HTML nội dung cũ được đặt vào trong website mới.

## 2. MỤC ĐÍCH CỦA TRANG

Trang phải giúp người dùng giải quyết nhanh 3 nhu cầu:

1. Hiểu cách tham gia cuộc thi.
2. Tìm câu trả lời cho các vấn đề thường gặp.
3. Biết liên hệ ai khi cần hỗ trợ.

Không cần navigation phụ bên trong trang.

## 3. KHÔNG CÓ "DANH MỤC HỖ TRỢ"

TUYỆT ĐỐI KHÔNG render sidebar/block:

```txt
Danh mục hỗ trợ
```

Không cần:

```txt
Hướng dẫn tham gia
Câu hỏi thường gặp
Liên hệ
Nguồn thông tin
```

ở dạng menu riêng.

Lý do: tất cả nội dung đã hiển thị trực tiếp trên cùng page. Không tạo thêm một tầng navigation không cần thiết.

## 4. KHÔNG CÓ "NGUỒN THÔNG TIN"

TUYỆT ĐỐI bỏ toàn bộ block:

```txt
Nguồn thông tin
```

Không hiển thị các source links riêng ở cuối trang chỉ để tham khảo. Thông tin liên hệ cần thiết được trình bày trực tiếp trong block `Liên hệ`.

Ghi chú: `/gioi-thieu` vẫn giữ khối nguồn của riêng nó. Chỉ `/ho-tro` bỏ.

## 5. SOURCE OF TRUTH

Ảnh mockup chỉ là visual reference.

SOURCE CODE / CONTENT hiện tại là nguồn sự thật.

Không tự:

- thay đổi FAQ
- đổi nội dung hướng dẫn
- đổi email
- đổi số điện thoại
- đổi địa chỉ
- đổi đơn vị liên hệ
- thêm người liên hệ
- thêm slogan
- thêm nguồn tham khảo
- thêm form liên hệ
- thêm chatbot
- thêm support ticket

## 6. KHÔNG BỊA NỘI DUNG

Không tự thêm:

```txt
24/7 Support
Live Chat
Gửi ticket
Phản hồi trong 2 giờ
Hotline khẩn cấp
```

nếu source hiện tại không có.

Không tạo fake contact.
Không tạo fake service SLA.

## 7. PAGE STRUCTURE

Desktop:

```txt
┌──────────────────────────────────────────────────────────────┐
│ GLOBAL NAVBAR                                                │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ [ICON] Hỗ trợ & Liên hệ                                     │
│        Subtitle                                              │
│        ─ blue ─ red ─ yellow                                 │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ ┌─────────────────────────────────┐ ┌──────────────────────┐ │
│ │                                 │ │                      │ │
│ │ HƯỚNG DẪN THAM GIA              │ │ LIÊN HỆ              │ │
│ │                                 │ │                      │ │
│ │ 1                               │ │ VKU                  │ │
│ │ 2                               │ │                      │ │
│ │ 3                               │ │ KHCN & HTQT          │ │
│ │ 4                               │ │                      │ │
│ │ 5                               │ │ Hỗ trợ kỹ thuật      │ │
│ │ 6                               │ │                      │ │
│ │                                 │ │ Warning/info         │ │
│ ├─────────────────────────────────┤ └──────────────────────┘ │
│ │                                 │                          │
│ │ CÂU HỎI THƯỜNG GẶP              │                          │
│ │                                 │                          │
│ │ accordion                       │                          │
│ │ accordion                       │                          │
│ │ accordion                       │                          │
│ │ ...                             │                          │
│ └─────────────────────────────────┘                          │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

## 8. DESKTOP GRID

Main content:

```css
.support-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.8fr) minmax(340px, 0.8fr);
  gap: 20px;
  align-items: start;
}
```

Left:

```txt
Hướng dẫn tham gia
+
FAQ
```

Right:

```txt
Liên hệ
```

Không thêm sidebar thứ ba.

## 9. PAGE CONTAINER

Trần rộng của trang là **1440px** (`--container-wide`), áp qua class shell `.app-main-support`
của `<main>` — cùng cách `.app-main-dashboard` áp cho `/`. Không đổi `--container` toàn cục.

```css
.app-main-support {
  max-width: var(--container-wide);
}
```

Bên trong trang chỉ căn giữa, không tự đặt trần rộng lần hai:

```css
.support-page {
  width: 100%;
  margin-inline: auto;
}
```

Padding ngang vẫn do shell quyết định (`--page-padding-inline`). Không giữ layout cũ quá hẹp giữa màn hình lớn.

## 10. PAGE BACKGROUND

```css
.support-page {
  min-height: 100vh;
  background: linear-gradient(180deg, #f7faff 0, #f8fafc 260px, #f8fafc 100%);
}
```

Không để toàn page pure white. Dải xanh rất nhạt nằm sau hero; phần còn lại là nền trung tính của hệ thống.

## 11. GLOBAL NAVBAR

Reuse navbar chung của website.

Không tạo navbar riêng cho page Hỗ trợ.

Navigation hiện tại:

```txt
Cuộc thi
Giới thiệu
Hỗ trợ
Quản trị      (chỉ admin)
Tài khoản     (chỉ admin)
```

Lấy từ `useNavItems()` trong `frontend/src/App.tsx`. Không hardcode lại navigation chỉ cho page này.

## 12. ACTIVE NAV

Tab `Hỗ trợ` dùng đúng style active sẵn có của `.app-nav a.active` trong `frontend/src/index.css`:

```css
background: #eaf3ff;
color: #064fc4;
box-shadow: inset 0 -2px 0 #0969e8;
```

Giống các nav active khác của hệ thống. Không thêm rule riêng cho `/ho-tro`.

## 13. PAGE HERO

Hero nhỏ, không phải marketing banner.

Desktop khoảng `130–170px`.

Bố cục ngang: icon bên trái, khối chữ bên phải icon.

```txt
[ICON]  Hỗ trợ & Liên hệ
        Subtitle
        ─ blue ─ red ─ yellow
```

## 14. HERO TITLE

```css
font-size: clamp(30px, 2.5vw, 38px);
font-weight: 750;
letter-spacing: -0.025em;
color: #0b1f44;
```

Là `h1` duy nhất của trang.

## 15. HERO SUBTITLE

Giữ đúng nội dung hiện tại:

```txt
Cách tham gia một cuộc thi, các câu hỏi thường gặp và đầu mối liên hệ chính thức.
```

Không tự thay bằng copy marketing.

Style:

```css
font-size: 15px;
color: #526078;
line-height: 1.6;
max-width: 42rem;
```

## 16. HERO ICON

Dùng SVG inline (repo không có icon package). Glyph đề xuất: phao cứu sinh / tai nghe / dấu hỏi trong vòng tròn.

Container:

```css
width: 60px;
height: 60px;
display: grid;
place-items: center;
border-radius: 14px;
background: linear-gradient(135deg, #eaf3ff 0%, #f5f9ff 100%);
border: 1px solid #cee1ff;
color: #064fc4;
```

Glyph 26×26, `stroke="currentColor"`, `aria-hidden="true"`, `focusable="false"`.

## 17. VKU ACCENT

Dưới subtitle:

```tsx
<div className="support-accent" aria-hidden="true">
  <span />
  <span />
  <span />
</div>
```

Style (giống `.ac-brand-accent` và `.admin-accounts-accent` đang dùng):

```css
.support-accent {
  display: flex;
  gap: 6px;
  margin-top: 16px;
}

.support-accent > span {
  width: 32px;
  height: 4px;
  border-radius: 999px;
}

.support-accent > span:nth-child(1) {
  background: #0969e8;
}
.support-accent > span:nth-child(2) {
  background: #ec1631;
}
.support-accent > span:nth-child(3) {
  background: #f5b800;
}
```

## 18. HERO DECORATION

Ba vệt chéo xanh–đỏ–vàng vẽ bằng CSS thuần ở góc phải, dùng lại đúng kỹ thuật đã có ở
`.dash-hero`, `.ac-page-head`, `.admin-accounts-head`:

```css
.support-hero::before {
  content: "";
  position: absolute;
  top: 0;
  right: 0;
  width: min(320px, 42%);
  height: 100%;
  background: linear-gradient(
    115deg,
    transparent 0 44%,
    var(--vku-blue-100) 44% 58%,
    var(--vku-red-50) 58% 70%,
    var(--vku-yellow-50) 70% 82%,
    transparent 82%
  );
  pointer-events: none;
}
```

Không tạo fake campus image. Không tạo AI-generated production asset. Không animation.

## 19. MAIN SECTION CARD

Base:

```css
.support-card {
  background: #ffffff;
  border: 1px solid #e5e7eb;
  border-radius: 14px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.02);
  padding: 20px 24px;
}
```

Mobile: `padding: 16px`.

## 20. HƯỚNG DẪN THAM GIA

Đây là block chính lớn nhất.

Theme: BLUE primary.

Top border:

```css
border-top: 3px solid #0969e8;
```

Header: `[Book icon] Các bước tham gia`.

## 21. HƯỚNG DẪN — HEADER

SVG inline glyph sách/checklist/lộ trình. Icon block:

```css
background: linear-gradient(135deg, #eaf3ff 0%, #f5f9ff 100%);
color: #064fc4;
border: 1px solid #cee1ff;
```

## 22. STEP TIMELINE

Không trình bày hướng dẫn dưới dạng 6 paragraph dài như UI cũ. Chuyển thành timeline.

Structure:

```txt
● 1  Đăng nhập
│    description
│
● 2  Chọn cuộc thi
│    description
│
● 3  Tham gia cuộc thi
...
```

Dùng `<ol>` để giữ list semantics; marker tròn hiển thị số thứ tự.

## 23. STEP COLOR RHYTHM

Luân phiên màu VKU theo vị trí render:

```txt
1 → BLUE
2 → RED
3 → YELLOW
4 → BLUE
5 → RED
6 → YELLOW
```

Color chỉ decorative. Không liên quan business state.

```tsx
const STEP_TONES = ["blue", "red", "yellow"] as const;
const tone = STEP_TONES[index % STEP_TONES.length];
```

## 24. TIMELINE NUMBER

```css
width: 32px;
height: 32px;
border-radius: 999px;
display: grid;
place-items: center;
font-size: 13px;
font-weight: 700;
```

Tone blue: nền `#eaf3ff`, viền `#0969e8`, chữ `#064fc4`.
Tone red: nền `#fff6f7`, viền `#ec1631`, chữ `#d30b23`.
Tone yellow: nền `#fffbeb`, viền `#f5b800`, chữ `#b45309` (tông vàng duy nhất đạt contrast 4.5:1).

Chữ đặt trên nền tinted nhạt chứ không phải nền đặc, để không phải dùng chữ trắng trên vàng.

## 25. TIMELINE CONNECTOR

```css
.support-timeline::before {
  content: "";
  position: absolute;
  left: 15px;
  top: 6px;
  bottom: 6px;
  width: 2px;
  background: var(--vku-border);
}
```

Không connector quá đậm.

## 26. STEP TITLE

Dùng chính title hiện có:

```txt
Đăng nhập
Chọn cuộc thi
Tham gia cuộc thi
Đọc đề bài
Nộp bài
Theo dõi kết quả
```

Style:

```css
font-size: 14px;
font-weight: 650;
color: #102446;
```

Accessible name của mỗi bước vẫn chứa "Bước N" qua text ẩn, để screen reader đọc được thứ tự.

## 27. STEP DESCRIPTION

Không sửa nội dung nghiệp vụ. Style:

```css
font-size: 13px;
line-height: 1.55;
color: #64748b;
```

## 28. TIMELINE SPACING

```css
gap: 18px;
```

Không làm 6 bước quá cao. Trang desktop nên nhìn thấy gần như toàn bộ timeline mà không cần scroll quá nhiều.

## 29. FAQ SECTION

Block dưới Hướng dẫn tham gia.

Theme: RED accent.

Top border:

```css
border-top: 3px solid #ec1631;
```

## 30. FAQ HEADER

```txt
[?] Câu hỏi thường gặp
```

Icon block:

```css
background: #fff6f7;
color: #d30b23;
border: 1px solid #ffecef;
```

## 31. FAQ PHẢI DÙNG ACCORDION

Không render toàn bộ câu trả lời cùng lúc như trang cũ. Dùng accordion.

Collapsed:

```txt
Tôi chưa có tài khoản thì làm sao?       ⌄
```

Expanded:

```txt
Tôi chưa có tài khoản thì làm sao?       ⌃

Nội dung trả lời...
```

## 32. FAQ ITEM

```css
border: 1px solid #e1e7ef;
border-radius: 8px;
background: #ffffff;
```

Hover:

```css
border-color: #bcd7ff;
background: #fafcff;
```

## 33. FAQ QUESTION

```css
font-size: 13px;
font-weight: 600;
color: #102446;
```

## 34. FAQ ANSWER

```css
font-size: 13px;
line-height: 1.65;
color: #58677e;
```

Không giảm nội dung. Chỉ thay presentation.

## 35. FAQ BEHAVIOR

Hiện tại FAQ là static content, nên implement local accordion UI. Đây là presentation interaction, không thay business logic.

Accessibility:

```txt
button (native, type="button")
aria-expanded
aria-controls
panel: role="region" + aria-labelledby
```

## 36. FAQ DEFAULT STATE

Tất cả collapsed. Chỉ một item mở tại một thời điểm; mở item khác thì item cũ tự đóng; bấm lại item đang mở thì đóng.

Panel luôn được mount và đóng bằng thuộc tính `hidden` (không unmount) để `aria-controls` không bao giờ trỏ vào phần tử không tồn tại.

## 37. CONTACT CARD

Right column.

Theme: YELLOW top accent.

```css
border-top: 3px solid #f5b800;
```

Mục tiêu: liên hệ phải nổi bật nhưng không giống alert nguy hiểm.

## 38. CONTACT HEADER

`[Phone icon] Liên hệ`.

Icon block giống các header khác (nền xanh nhạt, chữ xanh):

```css
background: linear-gradient(135deg, #eaf3ff 0%, #f5f9ff 100%);
color: #064fc4;
```

## 39. CONTACT GROUPS

Mỗi đầu mối là một sub-section riêng, theo đúng source hiện tại:

```txt
1. Trường Đại học Công nghệ Thông tin và Truyền thông Việt - Hàn, Đại học Đà Nẵng

2. Phòng Khoa học Công nghệ - Hợp tác Quốc tế

3. Hỗ trợ kỹ thuật nền tảng
```

Không hardcode nếu source thay đổi — lấy từ `frontend/src/lib/vkuInfo.ts`.

## 40. CONTACT ITEM

Structure:

```txt
[ICON] Organization / person
       Description
       [email] [phone] [website/action]
```

Không viết tất cả thành một paragraph dài.

## 41. CONTACT SUBCARD

```css
padding: 16px;
border: 1px solid #e7ebf0;
border-radius: 10px;
background: #ffffff;
```

Giữa các contact: `12px` gap. Không cần mỗi contact shadow riêng.

## 42. ORGANIZATION TITLE

```css
font-size: 13px;
font-weight: 700;
line-height: 1.4;
color: #102446;
```

## 43. CONTACT DESCRIPTION

```css
font-size: 12.5px;
line-height: 1.55;
color: #64748b;
```

## 44. CONTACT ACTION CHIP

Email / phone / website:

```css
display: inline-flex;
align-items: center;
gap: 6px;
min-height: 44px;
padding-inline: 10px;
background: #ffffff;
border: 1px solid #d8e1ec;
border-radius: 7px;
font-size: 12px;
color: #174b91;
```

Hover:

```css
background: #f4f8ff;
border-color: #b9d5ff;
```

Từ `min-height: 44px` trở lên để đạt touch target. Chip wrap khi hẹp, không overflow.

## 45. EMAIL

Dùng `mailto:` như implementation hiện tại. Không tự thay email.

Trong anchor chỉ có icon decorative (`aria-hidden`) và chính giá trị email — không thêm text hay
nhãn ẩn nào khác, để accessible name vẫn đúng bằng email.

## 46. PHONE

Dùng `tel:` như implementation hiện tại. Không tự format lại thành số khác.

## 47. WEBSITE / UNIT PAGE

Render neutral action màu xanh. Không tự thêm URL.

Hiện có hai action ngoài:

- `https://vku.udn.vn/` — nhãn `vku.udn.vn`
- `https://vku.udn.vn/vi/co-cau-to-chuc/phong-khoa-hoc-cong-nghe-hop-tac-quoc-te/` — nhãn `Trang đơn vị`

Cả hai giữ `target="_blank"` + `rel="noopener noreferrer nofollow"`.

## 48. SUPPORT WARNING/NOTE

Phần:

```txt
Nền tảng không có biểu mẫu liên hệ; vui lòng dùng email hoặc điện thoại ở trên.
```

Render dưới dạng YELLOW note:

```css
background: #fffbeb;
border: 1px solid #fff5cc;
border-left: 4px solid #f5b800;
border-radius: 8px;
color: #b45309;
```

Không italic, không phải CTA, không có button.

## 49. KHÔNG CÓ SUPPORT CATEGORY CARD

Không tạo `Danh mục hỗ trợ` ở desktop. Không tạo lại ở mobile.

## 50. KHÔNG CÓ SOURCE INFORMATION CARD

Không render `Nguồn thông tin` ở bất cứ breakpoint nào.

## 51. KHÔNG CÓ "CẦN HỖ TRỢ THÊM?" CARD RIÊNG

Không cần block:

```txt
Cần hỗ trợ thêm?
Liên hệ ngay
```

vì bên phải đã có block `Liên hệ`. Tránh duplicate CTA.

## 52. PAGE HEIGHT

Sau khi loại category/source/duplicate CTA, page phải gọn hơn.

Desktop mục tiêu: Hướng dẫn + Contact nhìn thấy ngay; FAQ bắt đầu trong first viewport hoặc ngay sau đó tùy resolution.

## 53. CONTACT CARD STICKY

**Không dùng sticky.**

Lý do:

- Panel liên hệ gồm 3 subcard + note vàng, có thể cao hơn viewport ở 1200–1280px.
- `VKU_GLOBAL_DESIGN.md` §10 yêu cầu header/sticky element không được che control đang focus.
- Sticky rail sẽ đẩy note vàng và tầng liên hệ thứ ba xuống dưới màn hình khi người dùng Tab qua các chip.

Trang không có phần tử sticky nào.

## 54. RESPONSIVE — LARGE DESKTOP

`>= 75rem` (1200px):

```css
.support-grid {
  grid-template-columns: minmax(0, 1.8fr) minmax(340px, 0.8fr);
  grid-template-areas:
    "guide   contact"
    "faq     contact";
}
```

Left ≈ 70%, Right ≈ 30%. Hero nằm ngang.

## 55. RESPONSIVE — TABLET

`768–1199px`: một cột.

```css
grid-template-columns: minmax(0, 1fr);
grid-template-areas: "guide" "contact" "faq";
```

Thứ tự: Hướng dẫn → Liên hệ → FAQ.

Chọn thứ tự này để contact không bị đẩy quá xa; và vì nó trùng với DOM order nên tab order luôn khớp visual order (WCAG 2.4.3).

## 56. RESPONSIVE — MOBILE

`< 768px`: single column, đúng thứ tự:

```txt
Hero
Hướng dẫn
Liên hệ
FAQ
```

Card padding `16px`. Timeline giữ vertical. Hero giảm padding nhưng không giảm dưới touch/contrast chuẩn.

## 57. MOBILE CONTACT ACTIONS

Email / phone chips:

```css
display: flex;
flex-wrap: wrap;
gap: 8px;
```

Không overflow. Email/URL dài dùng `overflow-wrap: anywhere`.

## 58. MOBILE FAQ

Accordion full width. Question text được wrap. Không giảm font quá nhỏ.

## 59. SECTION SPACING

```txt
Hero → content:       24px
Card gap:             20px
Header → body:        16–20px
Contact groups:       12px
```

## 60. CARD PADDING

Desktop: `20px 24px`. Mobile: `16px`.

## 61. COLORS BY SECTION

```text
PAGE HEADER              BLUE dominant
HƯỚNG DẪN THAM GIA       BLUE top accent
Timeline                 BLUE / RED / YELLOW alternating
FAQ                      RED top accent
LIÊN HỆ                  YELLOW top accent
Contact action icons     BLUE
Important note           YELLOW
Success state            GREEN only when semantic
```

## 62. KHÔNG LÀM PAGE QUÁ NHIỀU MÀU

Không dùng blue/red/yellow làm nền card body. Card body vẫn WHITE.

Brand color xuất hiện ở: top border, icon, active state, timeline marker, CTA, badge và accent nhỏ.

## 63. ICON LIBRARY

Repo **không có** icon package (không Lucide, không Heroicons). Mọi icon là SVG inline theo
convention hiện có:

```tsx
<svg
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  strokeWidth={1.8}
  strokeLinecap="round"
  strokeLinejoin="round"
  aria-hidden="true"
  focusable="false"
>
```

Không dùng emoji.

## 64. TYPOGRAPHY

Dùng token hiện có của `frontend/src/index.css`.

| Vai trò | Token / giá trị |
|---|---|
| Main title (h1) | `clamp(30px, 2.5vw, 38px)`, 700 |
| Section title (h2) | `--text-h2` / `--text-h2-desktop` |
| Item title (h3) | `--text-body`, 650–700 |
| Body | `--text-body-sm` (≈13–14px) |
| Label/meta | `--text-label` (12px) |

## 65. ACCESSIBILITY

Required:

- FAQ trigger là `button` native, `type="button"`.
- `aria-expanded` + `aria-controls`; panel `role="region"` + `aria-labelledby`.
- Heading hierarchy: một `h1`, section `h2`, item `h3`.
- Email/phone actionable bằng `mailto:`/`tel:` hiện có.
- `:focus-visible` ring 2px (rule chung đã có ở `index.css`).
- Contrast AA; vàng dùng `--vku-yellow-800` cho chữ.
- Icon decorative dùng `aria-hidden="true"`.
- Không truyền đạt trạng thái chỉ bằng màu: chevron + `aria-expanded` + panel hiển thị.

## 66. LOADING

Page data tĩnh: không cần fake loading, không skeleton giả.

## 67. ERROR

Page không fetch nên không có error state. Nếu sau này có, reuse error handling hiện có và không tự hide cả page.

## 68. NO EXTRA API

Không tạo API mới. Không fetch website VKU lúc runtime để hiển thị contact. Dùng dữ liệu có trong app.

## 69. NO NEW LIBRARY

Không cài FAQ library, timeline library hay animation package. Timeline và accordion làm bằng React + CSS thuần.

## 70. SUGGESTED COMPONENT STRUCTURE

Page đủ đơn giản để render trong một file. Cấu trúc hợp lý:

```txt
SupportPage
│
├── SupportHero
│
├── ParticipationGuide (timeline 6 bước)
│
├── ContactPanel (3 tầng)
│
└── SupportFAQ (accordion 9 item)
```

Không tạo component cho từng dòng text. Không tách file mới cho scope này.

## 71. GUIDE DATA

Hướng dẫn chuyển từ JSX hardcode sang array để render sạch hơn:

```tsx
type GuideStep = { title: string; description: ReactNode };
```

Giữ nguyên nội dung hiện tại. Không rewrite wording chỉ vì refactor.

## 72. FAQ DATA

```tsx
type FaqItem = { id: string; question: string; answer: ReactNode };
```

`answer` là `ReactNode` vì item "Tôi muốn tổ chức cuộc thi trên nền tảng?" nội suy tên đơn vị từ
`vkuInfo.ts`. Không thay text.

## 73. CONTACT DATA

```tsx
type ContactItem = { title: string; description: string; actions: ContactAction[] };
type ContactAction = { label: string; href: string; icon: "mail" | "phone" | "site" };
```

`actions` lấy trực tiếp từ constant của `vkuInfo.ts`. Không tạo content mới.

## 74. DO NOT OVER-ABSTRACT

Không cần `GenericInformationPortalFactory` hay abstraction phức tạp. Đây là một page nội dung đơn giản.

## 75. HOVER

Subtle only:

```css
transition:
  border-color 160ms ease,
  background-color 160ms ease,
  box-shadow 160ms ease;
```

Không translate lớn. Chevron xoay 180ms khi mở.

## 76. FINAL DESKTOP VISUAL

```text
       Hỗ trợ & Liên hệ
       subtitle + VKU accent

┌──────────────────────────────────┐  ┌─────────────────────────┐
│  HƯỚNG DẪN THAM GIA              │  │  LIÊN HỆ                │
│  ● 1 Đăng nhập                   │  │  VKU                    │
│  ● 2 Chọn cuộc thi               │  │  KHCN & HTQT            │
│  ● 3 Tham gia                    │  │  Hỗ trợ kỹ thuật        │
│  ...                             │  │  [email] [phone]        │
└──────────────────────────────────┘  └─────────────────────────┘

┌──────────────────────────────────┐
│  CÂU HỎI THƯỜNG GẶP             │
│  Q1                           ▾   │
│  Q2                           ▾   │
└──────────────────────────────────┘
```

## 77. FORBIDDEN

TUYỆT ĐỐI KHÔNG:

- thêm Danh mục hỗ trợ
- thêm Nguồn thông tin
- thêm support sidebar
- thêm CTA duplicate
- fake contact
- fake slogan
- fake statistics
- fake hero photo
- fake footer
- black primary CTA
- huge hero
- giant empty whitespace
- paragraph wall như UI cũ
- render toàn bộ FAQ answer cùng lúc
- thêm chart
- thêm ticketing feature
- thay contact data
- sửa auth/navigation logic
- sửa route

## 78. ACCEPTANCE CRITERIA

- [ ] Đồng nhất với VKU Global Design.
- [ ] Navbar đồng nhất.
- [ ] Hỗ trợ active nav rõ ràng.
- [ ] Header có VKU accent.
- [ ] Không có `Danh mục hỗ trợ`.
- [ ] Không có `Nguồn thông tin`.
- [ ] Không có duplicate support CTA.
- [ ] Hướng dẫn được trình bày thành timeline.
- [ ] Timeline dùng blue/red/yellow.
- [ ] Không thay wording hướng dẫn.
- [ ] FAQ dùng accordion.
- [ ] Không làm mất FAQ nào.
- [ ] Contact panel rõ ràng.
- [ ] Email/phone không bị thay đổi.
- [ ] Các contact được chia hierarchy rõ.
- [ ] Card body chủ yếu white.
- [ ] Blue là primary.
- [ ] Red và Yellow đủ nhận diện.
- [ ] Green chỉ semantic.
- [ ] Không black primary button.
- [ ] Không fake content.
- [ ] Desktop đẹp.
- [ ] Tablet responsive.
- [ ] Mobile responsive.
- [ ] TypeScript pass.
- [ ] Lint không phát sinh error mới.
- [ ] Production build pass.

---

## 79. GHI CHÚ RIÊNG CỦA REPOSITORY

Các điểm dưới đây khớp tài liệu này với code hiện tại; phần còn lại giữ nguyên.

- **Thứ tự authority.** `VKU_GLOBAL_DESIGN.md` là authority cao nhất, sau đó `DESIGN.md`, rồi tài
  liệu page-specific. Khi guidance về hình ảnh mâu thuẫn thì tài liệu cấp trên thắng; khi guidance
  về dữ liệu/hành vi mâu thuẫn thì source code và API contract thắng.
- **CSS thuần, một file.** Toàn bộ style nằm ở `frontend/src/index.css`. Không Tailwind, không CSS
  Modules, không CSS-in-JS. Mọi selector của trang nằm dưới namespace `.support-*` và
  `.app-main-support`.
- **Icon là SVG inline.** Repo không có icon package; glyph được khai báo ngay trong page với
  `aria-hidden="true" focusable="false"` và `stroke="currentColor"`.
- **Light mode only.** `color-scheme: light` khoá ở `:root`; không thêm `prefers-color-scheme: dark`.
- **Trần rộng 1440px.** Áp qua `.app-main-support` cho đúng route `/ho-tro`, không đổi
  `--container` toàn cục. Đây là ngoại lệ page-specific mà `VKU_GLOBAL_DESIGN.md` §9 cho phép.
- **Breakpoint desktop là `75rem` (1200px)**, không phải 1024px: rail contact 30% ở 1024px chỉ còn
  ~215px, quá hẹp cho chip email. Dưới 1200px giữ một cột.
- **Timeline title không lặp "Bước N".** Marker tròn đã hiển thị số thứ tự; title thị giác là
  "Đăng nhập", "Chọn cuộc thi"… Thông tin "Bước N" vẫn còn dưới dạng text ẩn để accessible name
  giữ đúng thứ tự.
- **FAQ mặc định đóng hết, mở một item tại một thời điểm.** Panel luôn mount và đóng bằng `hidden`.
  CSS không được khai báo `display` trên `.support-faq-panel` vì sẽ đè lên semantics của `hidden`.
- **Contact không sticky.** Xem §53.
- **Bỏ heading wrapper cũ.** Card cũ bọc tất cả trong `.card` với `h2 "Tham gia & hỗ trợ"`. Layout
  mới không còn khối bọc đó, nên heading này bị bỏ và ba tiêu đề section được nâng từ `h3` lên `h2`.
  Đây là thay đổi duy nhất về cấu trúc heading.
- **`SOURCE_ACCESSED` không còn hiển thị ở `/ho-tro`.** Từ 2026-09-18 nó cũng không còn hiển thị
  ở `/gioi-thieu` (user bỏ câu dẫn "truy cập ngày…"), nên hằng này đã được xoá hẳn khỏi
  `frontend/src/lib/vkuInfo.ts`.
