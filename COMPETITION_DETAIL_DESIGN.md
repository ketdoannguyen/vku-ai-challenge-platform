# COMPETITION_DETAIL_DESIGN.md
# VKU AI Challenge - Competition Detail Administration

> Design specification cho toàn bộ module Chi tiết cuộc thi.
>
> Module gồm 5 tab:
>
> 1. Nội dung
> 2. Assets
> 3. Chấm điểm
> 4. Kết quả
> 5. Thành viên & mã tham gia
>
> File này kế thừa:
>
> - DESIGN.md
> - ADMIN_COMPETITIONS_DESIGN.md
>
> Không thay đổi business logic hiện tại.
> Chỉ redesign UI/UX.

---

# 1. DESIGN GOAL

Mục tiêu của màn hình Chi tiết cuộc thi:

- đồng nhất hoàn toàn với trang "Cuộc thi"
- đồng nhất với trang "Quản lý cuộc thi"
- mang nhận diện VKU rõ ràng
- sử dụng mạnh hơn 3 màu:
  - VKU Blue
  - VKU Red
  - VKU Yellow
- clean
- professional
- academic
- hiện đại
- nhiều khoảng trắng
- dễ scan thông tin
- không giống template admin generic
- không giống poster sự kiện
- không glassmorphism nặng
- không màu mè quá mức

Các block chính nên có màu VKU rõ hơn phiên bản hiện tại.

Tuy nhiên:

- nền trang vẫn sáng
- table vẫn dễ đọc
- form vẫn ưu tiên usability
- màu không được làm giảm contrast

---

# 2. NGUYÊN TẮC QUAN TRỌNG NHẤT

Ảnh mockup CHỈ là visual reference.

SOURCE CODE HIỆN TẠI mới là nguồn sự thật.

KHÔNG tự tạo dữ liệu.

KHÔNG thay đổi:

- API
- endpoint
- request payload
- response type
- schema
- database
- route
- query param
- authentication
- authorization
- admin permission
- competition status logic
- competition lifecycle
- edit logic
- clone logic
- end/close logic
- content CRUD
- asset upload logic
- Markdown logic
- scoring config
- ground truth logic
- submission scoring
- leaderboard
- member management
- invitation code logic
- pagination
- filtering
- sorting

Không hardcode dữ liệu từ screenshot.

Ví dụ:

```txt
AI Challenge
ai-challenge
F1
5 lượt/ngày
12/09/2026
14 dòng
```

chỉ được hiển thị nếu API hiện tại trả về những giá trị đó.

---

# 3. TOÀN BỘ MODULE DÙNG MỘT DETAIL SHELL

Không thiết kế 5 page độc lập hoàn toàn.

Cấu trúc:

```txt
CompetitionDetailPage
│
├── CompetitionDetailHeader
│
├── CompetitionSummaryStrip
│
├── CompetitionDetailTabs
│
└── ActiveTabContent
    │
    ├── ContentTab
    ├── AssetsTab
    ├── ScoringTab
    ├── ResultsTab
    └── MembersTab
```

Điều này rất quan trọng để:

- UI nhất quán
- không duplicate code
- chuyển tab mượt
- dễ maintain

---

# 4. VKU COLOR SYSTEM

Dùng chung toàn module.

```css
:root {
  /* ========================================= */
  /* VKU BLUE                                  */
  /* ========================================= */

  --vku-blue-950: #06245F;
  --vku-blue-900: #082B73;
  --vku-blue-800: #073B9A;
  --vku-blue-700: #064FC4;
  --vku-blue-600: #0969E8;
  --vku-blue-500: #1677FF;

  --vku-blue-200: #BFDBFE;
  --vku-blue-100: #DBEAFE;
  --vku-blue-50: #EFF6FF;

  /* ========================================= */
  /* VKU RED                                   */
  /* ========================================= */

  --vku-red-900: #991B1B;
  --vku-red-800: #B80619;
  --vku-red-700: #D30B23;
  --vku-red-600: #EC1631;
  --vku-red-500: #F3263F;

  --vku-red-200: #FECACA;
  --vku-red-100: #FFE4E6;
  --vku-red-50: #FFF1F2;

  /* ========================================= */
  /* VKU YELLOW                                */
  /* ========================================= */

  --vku-yellow-800: #B77900;
  --vku-yellow-700: #D89600;
  --vku-yellow-600: #F5B800;
  --vku-yellow-500: #FFC51B;
  --vku-yellow-400: #FFD43B;

  --vku-yellow-200: #FDE68A;
  --vku-yellow-100: #FEF3C7;
  --vku-yellow-50: #FFFBEB;

  /* ========================================= */
  /* NEUTRAL                                   */
  /* ========================================= */

  --page-background: #F7F9FC;
  --surface: #FFFFFF;

  --border: #DFE5EC;
  --border-soft: #EDF1F5;

  --text-primary: #0B1F44;
  --text-secondary: #53627A;
  --text-muted: #8491A5;

  /* ========================================= */
  /* STATUS                                    */
  /* ========================================= */

  --success: #059669;
  --success-bg: #ECFDF5;

  --warning: #D97706;
  --warning-bg: #FFFBEB;

  --danger: #DC2626;
  --danger-bg: #FEF2F2;
}
```

---

# 5. TỶ LỆ MÀU TOÀN MODULE

Không biến UI thành rainbow dashboard.

Dùng tương đối:

```txt
Blue     ~ 65%
Red      ~ 20%
Yellow   ~ 15%
```

BLUE:

- navigation
- active tab
- primary CTA
- icons chính
- information blocks
- section accents
- selected states

RED:

- destructive action
- "Kết thúc"
- một số section accent
- ranking / important action accent
- alternating brand decorative accents

YELLOW:

- warning
- highlight
- secondary information
- selected content state
- visibility / invitation accents

---

# 6. KHÔNG DÙNG BLACK BUTTON LÀM PRIMARY

UI cũ có nhiều button màu đen.

Redesign:

Primary action:

```css
background: var(--vku-blue-700);
color: white;
```

Hover:

```css
background: var(--vku-blue-800);
```

Danger:

```css
background: var(--vku-red-50);
color: var(--vku-red-700);
border: 1px solid var(--vku-red-200);
```

Yellow action chỉ dùng ở những chỗ secondary/highlight.

---

# 7. PAGE BACKGROUND

```css
.competition-detail-page {
  min-height: 100vh;
  background:
    linear-gradient(
      180deg,
      #F7FAFF 0,
      #F8FAFC 240px,
      #F8FAFC 100%
    );
}
```

Không pure white toàn trang.

---

# 8. PAGE WIDTH

```css
.detail-container {
  width: min(calc(100% - 48px), 1440px);
  margin-inline: auto;
}
```

Large screen:

```txt
max-width = 1440px
```

Không kéo UI đến sát 2 mép màn hình.

---

# 9. COMMON DETAIL HEADER

Header áp dụng cho cả 5 tab.

Structure:

```txt
← Quản lý cuộc thi

[ICON] AI Challenge       ● Đang diễn ra

       ai-challenge

                                     [Sửa] [Clone] [Kết thúc]
```

Desktop:

```txt
title left
actions right
```

Mobile:

```txt
title
status
actions wrap below
```

---

# 10. COMPETITION TITLE

```css
font-size: clamp(28px, 2.4vw, 38px);
font-weight: 750;
letter-spacing: -0.02em;
color: #0B1F44;
```

Status nằm ngay bên cạnh title.

Không để status cách quá xa.

---

# 11. COMPETITION ICON BLOCK

Để tăng character VKU:

```css
width: 58px;
height: 58px;
border-radius: 14px;

background:
  linear-gradient(
    135deg,
    var(--vku-blue-100),
    var(--vku-blue-50)
  );

border: 1px solid var(--vku-blue-200);
```

Icon màu:

```css
color: var(--vku-blue-600);
```

Có thể dùng icon chung:

```txt
Trophy
BrainCircuit
Bot
Sparkles
```

nhưng chỉ decorative.

Không suy diễn loại competition từ icon.

Nếu project không cần icon, có thể bỏ.

---

# 12. DETAIL HEADER BRAND ACCENT

Có thể thêm line nhỏ:

```tsx
<div className="vku-accent">
  <span className="blue" />
  <span className="red" />
  <span className="yellow" />
</div>
```

CSS:

```css
.vku-accent {
  display: flex;
  gap: 5px;
}

.vku-accent span {
  display: block;
  width: 26px;
  height: 4px;
  border-radius: 999px;
}

.vku-accent .blue {
  background: #0969E8;
}

.vku-accent .red {
  background: #EC1631;
}

.vku-accent .yellow {
  background: #FFC51B;
}
```

---

# 13. HEADER ACTION BUTTONS

## Edit

Neutral/blue outline.

```txt
✎ Sửa
```

## Clone

Neutral/blue outline.

```txt
▣ Clone
```

## End competition

RED destructive.

```txt
⊙ Kết thúc
```

Không đổi behavior.

Không thay text nếu source hiện tại dùng text khác.

---

# 14. COMPETITION SUMMARY STRIP

Thay box thông tin rất phẳng hiện tại bằng 1 summary card rõ ràng hơn.

Desktop:

```txt
┌────────────────────────────────────────────────────────────────────────┐
│ THAM GIA │ BẮT ĐẦU │ CHỈ SỐ CHÍNH │ QUOTA │ KẾT THÚC                 │
└────────────────────────────────────────────────────────────────────────┘
```

Hoặc nếu project vẫn cần slug:

```txt
SLUG │ THAM GIA │ BẮT ĐẦU │ KẾT THÚC │ CHỈ SỐ │ QUOTA
```

Không xóa data hiện tại.

---

# 15. SUMMARY ITEM

Mỗi item:

```txt
[ICON] LABEL
       VALUE
```

Desktop:

```css
min-height: 96px;
padding: 20px 24px;
```

Divider:

```css
border-right: 1px solid #E7EBF1;
```

---

# 16. SUMMARY COLOR ROTATION

Dùng color pattern VKU để strip sống động hơn.

```txt
Item 1 → BLUE
Item 2 → RED
Item 3 → YELLOW
Item 4 → BLUE
Item 5 → RED
Item 6 → YELLOW
```

NHƯNG:

chỉ icon/background accent đổi màu.

Text vẫn:

```txt
#0B1F44
```

Ví dụ icon background:

BLUE:

```css
background: #EAF3FF;
color: #0969E8;
```

RED:

```css
background: #FFF1F2;
color: #EC1631;
```

YELLOW:

```css
background: #FFFBEB;
color: #D89600;
```

---

# 17. DETAIL TABS

Tabs:

```txt
Nội dung
Assets
Chấm điểm
Kết quả
Thành viên & mã tham gia
```

Không đổi route/navigation logic hiện tại.

Container:

```css
background: white;
border: 1px solid #E1E7EF;
border-radius: 13px;
padding: 6px;
```

---

# 18. TAB DESIGN

Inactive:

```css
color: #526078;
background: transparent;
```

Hover:

```css
background: #F5F8FC;
color: #0B1F44;
```

Active:

```css
background: #EAF3FF;
color: #0759C7;

border: 1px solid #BAD6FF;
box-shadow: inset 0 -2px 0 #0969E8;
```

Active tab phải rõ hơn UI cũ.

Có icon nếu project đã dùng icon library.

---

# 19. TAB ICONS

Suggested:

```txt
Nội dung                FileText
Assets                   Image
Chấm điểm                Settings / Gauge
Kết quả                  Trophy / ChartNoAxesColumnIncreasing
Thành viên & mã tham gia Users
```

Reuse icon library hiện tại.

Không install library mới nếu đã có icon package.

---

# 20. COMMON SECTION CARD

Các block nội dung dùng một base style:

```css
.detail-section {
  background: #FFFFFF;
  border: 1px solid #DEE5ED;
  border-radius: 14px;
  box-shadow:
    0 1px 2px rgba(15, 23, 42, 0.02),
    0 8px 24px rgba(15, 23, 42, 0.035);
}
```

---

# 21. VKU SECTION TOP ACCENT

Để "block đỏ xanh vàng VKU nhiều hơn":

Các main block có thể dùng top border:

BLUE:

```css
border-top: 3px solid #0969E8;
```

RED:

```css
border-top: 3px solid #EC1631;
```

YELLOW:

```css
border-top: 3px solid #F5B800;
```

Không dùng cả 3 màu trên cùng một block.

Luân phiên có chủ ý.

---

# ============================================================
# PAGE 1 - NỘI DUNG
# ============================================================

# 22. CONTENT TAB GOAL

Trang quản lý:

- các trang nội dung
- thứ tự
- title
- slug
- visibility
- file Markdown
- edit/delete

Giữ toàn bộ chức năng hiện tại.

---

# 23. CONTENT TAB LAYOUT

```txt
┌───────────────────────────────────────────────────────────┐
│ [BLUE ICON] Quản lý nội dung       [+ Thêm trang nội dung]│
│             description                                   │
├───────────────────────────────────────────────────────────┤
│ TABLE                                                     │
│                                                           │
└───────────────────────────────────────────────────────────┘
```

Main section:

```css
border-top: 3px solid var(--vku-blue-600);
```

---

# 24. CONTENT HEADER

Left:

```txt
Quản lý nội dung
```

Description optional:

```txt
Thêm, chỉnh sửa các trang nội dung của cuộc thi.
```

Chỉ dùng nếu phù hợp với chức năng thực tế.

Không bắt buộc thêm description nếu source hiện tại không cần.

Right:

```txt
+ Thêm trang nội dung
```

CTA màu BLUE.

---

# 25. CONTENT TABLE

Giữ columns hiện tại.

Ví dụ:

```txt
THỨ TỰ
TIÊU ĐỀ
SLUG
HIỂN THỊ
FILE
THAO TÁC
```

Không xóa logic reorder.

---

# 26. CONTENT ROW COLOR DETAIL

Không tô cả row.

Dùng badges:

Visibility:

```txt
Chỉ thành viên
```

→ YELLOW badge.

```css
background: #FFF7DB;
border: 1px solid #FDE08B;
color: #A45E00;
```

Uploaded:

→ GREEN badge.

Delete:

→ RED.

Edit:

→ BLUE outline.

---

# 27. ORDER CONTROL

Order input:

```css
width: 56px;
height: 38px;
text-align: center;
```

Arrow buttons nhỏ.

Không làm arrows quá nổi.

---

# 28. FILE ACTION

`Thay .md`

button neutral/blue outline.

`Sửa`

blue outline.

`Xóa`

red.

Không dùng button black.

---

# ============================================================
# PAGE 2 - ASSETS
# ============================================================

# 29. ASSETS TAB GOAL

Trang quản lý hình/tài nguyên dùng trong Markdown.

Giữ:

- upload
- file limits
- search
- copy reference
- delete
- Markdown reference syntax

---

# 30. ASSETS TOP LAYOUT

Desktop:

```txt
┌──────────────────────────────────────┐ ┌─────────────────────┐
│ Kho lưu trữ hình ảnh                 │ │ Quy chuẩn Markdown  │
│                                      │ │                     │
│ [Upload ảnh]                         │ │ path example        │
└──────────────────────────────────────┘ └─────────────────────┘
```

Grid:

```css
grid-template-columns: minmax(0, 2fr) minmax(320px, 1fr);
gap: 20px;
```

---

# 31. ASSET UPLOAD CARD

Theme BLUE.

```css
border-top: 3px solid #0969E8;
```

Icon block:

```css
background: #EAF3FF;
color: #0969E8;
```

Upload CTA:

```css
background: #0759C7;
color: white;
```

Không dùng black.

---

# 32. MARKDOWN RULE CARD

Theme YELLOW.

```css
border-top: 3px solid #F5B800;
```

Header icon:

```css
background: #FFFBEB;
color: #D89600;
```

Code path:

```css
font-family: "JetBrains Mono", Consolas, monospace;
background: #F7F9FC;
border: 1px solid #DDE4EC;
```

Copy:

blue outline.

---

# 33. ASSET LIST

Asset list = section thứ 2.

Theme RED accent để tăng VKU identity:

```css
border-top: 3px solid #EC1631;
```

Không làm toàn block đỏ.

Title:

```txt
Danh sách tài nguyên đã tải lên
```

Search bên phải.

---

# 34. ASSET FILE TABLE

Giữ columns hiện tại:

```txt
TÊN FILE
LOẠI
DUNG LƯỢNG
DÙNG TRONG MARKDOWN
THAO TÁC
```

Filename dùng monospace chip.

Type:

neutral badge.

Copy reference:

blue.

Delete:

red.

---

# ============================================================
# PAGE 3 - CHẤM ĐIỂM
# ============================================================

# 35. SCORING TAB GOAL

Đây là trang quan trọng nhất về configuration.

Visual phải:

- rõ
- kỹ thuật
- nghiêm túc
- không quá decorative

---

# 36. SCORING LAYOUT

Desktop:

```txt
┌────────────────────────────────────────┐ ┌────────────────────────┐
│ Cấu hình CSV                           │ │ Ground truth private   │
│                                        │ │                        │
│ Warning                                │ │ Dataset info           │
│                                        │ │                        │
│ ID             Prediction              │ │ Replace CSV            │
│ Label          Average                 │ └────────────────────────┘
│ Positive                               │
│                                        │ ┌────────────────────────┐
│ [Lưu cấu hình]                         │ │ Hướng dẫn định dạng    │
└────────────────────────────────────────┘ └────────────────────────┘
```

Grid:

```css
grid-template-columns:
  minmax(0, 1.65fr)
  minmax(320px, 0.85fr);

gap: 20px;
```

---

# 37. CSV CONFIG CARD

Theme BLUE.

```css
border-top: 3px solid #0969E8;
```

Header:

```txt
[gear icon] Cấu hình CSV             [Sẵn sàng chấm điểm]
```

Status success giữ green.

---

# 38. SCORING FORM

2 columns desktop:

```css
display: grid;
grid-template-columns: repeat(2, minmax(0, 1fr));
gap: 18px 20px;
```

Mobile:

```txt
1 column
```

---

# 39. INPUTS

```css
height: 46px;
border: 1px solid #DCE3EC;
border-radius: 8px;
background: #FFFFFF;
```

Disabled:

```css
background: #F3F5F7;
color: #738095;
```

Focus:

```css
border-color: #1677FF;
box-shadow:
  0 0 0 3px rgba(22, 119, 255, 0.10);
```

---

# 40. WARNING BLOCK

Theme YELLOW.

```css
background: #FFF9E8;
border: 1px solid #F6D66C;
border-left: 4px solid #F5B800;
```

Icon yellow/orange.

Không dùng alert màu xám.

---

# 41. GROUND TRUTH CARD

Theme RED.

Không phải vì danger mà để tăng brand balance.

```css
border-top: 3px solid #EC1631;
```

Header icon có thể BLUE/RED phối hợp:

```css
background: #FFF1F2;
color: #D30B23;
```

Information table:

```txt
Dữ liệu
Các cột
Upload lúc
```

Values align right.

---

# 42. CHANGE GROUND TRUTH

Nếu action hiện tại disabled:

giữ disabled.

Nếu available:

button BLUE outline.

Không thay state.

---

# 43. FORMAT GUIDE CARD

Theme YELLOW.

```css
border-top: 3px solid #F5B800;
background:
  linear-gradient(
    135deg,
    #FFFFFF,
    #FFFCF2
  );
```

Không tự sinh hướng dẫn nếu backend/app không có.

Chỉ hiển thị information dựa trên config hiện tại.

---

# ============================================================
# PAGE 4 - KẾT QUẢ
# ============================================================

# 44. RESULTS TAB GOAL

Bao gồm:

- leaderboard
- export
- submissions
- filtering
- metrics

Đây là data-heavy page.

Giữ tối đa sự rõ ràng.

---

# 45. LEADERBOARD CARD

Theme YELLOW.

Trophy = yellow.

```css
border-top: 3px solid #F5B800;
```

Header:

```txt
[Trophy] Bảng xếp hạng                         [Xuất Excel]
```

Export button:

BLUE.

Không dùng black.

---

# 46. LEADERBOARD TABLE

Columns lấy source hiện tại.

Ví dụ:

```txt
HẠNG
ĐỘI
ĐIỂM CHÍNH
F1
PRECISION
RECALL
SỐ BÀI
```

Không hardcode metrics.

Nếu competition metric khác:

render theo data/config hiện tại.

---

# 47. RANK UI

Rank badge:

1:

```css
background: #FFF3BF;
color: #9A6700;
border: 1px solid #F6D358;
```

2:

```css
background: #F1F5F9;
color: #475569;
```

3:

```css
background: #FFF1E8;
color: #A34B14;
```

Không tạo medal/icon nếu project không cần.

---

# 48. MAIN SCORE

Primary metric value:

```css
font-weight: 700;
color: #0759C7;
```

Không làm tất cả metric cùng bold.

---

# 49. SUBMISSION SECTION

Theme BLUE.

```css
border-top: 3px solid #0969E8;
```

Title:

```txt
Danh sách submissions
```

Subtitle:

count hiện tại.

---

# 50. SUBMISSION FILTER

Desktop:

```txt
[ Search team/email ................ ] [Status ▼] [Lọc]
```

Filter button:

BLUE.

Không black.

Search:

full available width.

---

# 51. SUBMISSION TABLE

Giữ columns hiện tại.

Ví dụ:

```txt
THỜI GIAN
ĐỘI
FILE
TRẠNG THÁI
F1
PRECISION
RECALL
ĐIỂM CHÍNH
```

Status scored:

GREEN badge.

Failed nếu source có:

RED badge.

Pending nếu source có:

YELLOW badge.

Không tự tạo status.

---

# ============================================================
# PAGE 5 - THÀNH VIÊN & MÃ THAM GIA
# ============================================================

# 52. MEMBERS TAB LAYOUT

Desktop:

```txt
┌────────────────────────┐ ┌─────────────────────────────────┐
│ Mã tham gia            │ │ Thành viên cuộc thi             │
│                        │ │               email [Thêm]      │
│ [input]                │ │                                 │
│                        │ │ TABLE                           │
│ [Đổi mã]               │ │                                 │
└────────────────────────┘ └─────────────────────────────────┘
```

Grid:

```css
grid-template-columns:
  minmax(300px, 0.75fr)
  minmax(0, 1.75fr);

gap: 20px;
```

---

# 53. JOIN CODE CARD

Theme RED + YELLOW.

Main top accent:

```css
border-top: 3px solid #EC1631;
```

Key icon:

```css
background: #FFF7DA;
color: #D89600;
```

Button:

BLUE.

Không dùng black.

```txt
Đổi mã
```

Giữ action logic hiện tại.

---

# 54. MEMBER CARD

Theme BLUE.

```css
border-top: 3px solid #0969E8;
```

Header:

```txt
[Users] Thành viên cuộc thi
        2 đang hoạt động
```

Right:

```txt
[email@...] [Thêm thành viên]
```

CTA:

BLUE.

---

# 55. MEMBER ROLE BADGES

Thí sinh:

neutral.

Admin:

BLUE.

Không dùng màu role nếu role source khác.

---

# 56. MEMBER STATUS

Active:

GREEN.

Disabled/removed nếu hiện tại có:

neutral/red tương ứng semantic.

Không tự tạo status.

---

# 57. MEMBER ACTION

Giữ action hiện có.

Icon-only menu:

```txt
•••
```

hoặc current actions.

Không tự đổi permission.

---

# ============================================================
# SHARED TABLE SYSTEM
# ============================================================

# 58. TABLE DESIGN

Tất cả tables dùng chung.

```css
.vku-table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
}
```

Header:

```css
background: #F8FAFD;
color: #526078;

font-size: 12px;
font-weight: 700;
letter-spacing: 0.025em;
```

Rows:

```css
min-height: 64px;
border-bottom: 1px solid #EDF1F5;
```

Hover:

```css
background: #FAFCFF;
```

---

# 59. TABLE BORDER

Không border đậm.

```css
border: 1px solid #E3E8EF;
border-radius: 10px;
overflow: hidden;
```

---

# 60. DATA FONT

Score / slug / filename có thể dùng monospace:

```css
font-family:
  "JetBrains Mono",
  "SFMono-Regular",
  Consolas,
  monospace;
```

Chỉ dùng monospace với:

- score
- slug
- filename
- path
- code-like value

Không dùng toàn UI.

---

# ============================================================
# COMMON COMPONENTS
# ============================================================

# 61. BUTTON SYSTEM

## Primary

```css
.btn-primary {
  background: #0759C7;
  color: white;
  border: 1px solid #0759C7;
}
```

## Secondary

```css
.btn-secondary {
  background: white;
  color: #163765;
  border: 1px solid #D5DEE9;
}
```

## Danger

```css
.btn-danger {
  background: #FFF5F5;
  color: #D30B23;
  border: 1px solid #FFC7CE;
}
```

## Yellow/highlight

Chỉ khi phù hợp:

```css
.btn-accent {
  background: #FFC51B;
  color: #342400;
}
```

---

# 62. BUTTON SIZES

Normal:

```css
height: 42px;
padding-inline: 16px;
border-radius: 8px;
```

Main CTA:

```css
height: 46px;
padding-inline: 20px;
```

---

# 63. BADGE

```css
height: 26px;
padding-inline: 10px;
border-radius: 9999px;
font-size: 12px;
font-weight: 600;
```

---

# 64. SECTION HEADER

Standard:

```txt
[ICON BLOCK] TITLE
             subtitle                    ACTION
```

Example:

```txt
⚙ Cấu hình CSV                 ● Sẵn sàng chấm điểm
  Thiết lập...
```

Icon square:

```css
width: 42px;
height: 42px;
border-radius: 10px;
```

---

# 65. SECTION ICON COLORS

Luân phiên:

```txt
Section 1 blue
Section 2 red
Section 3 yellow
Section 4 blue
```

nhằm thể hiện VKU brand.

Không dùng index color để biểu diễn business state.

---

# ============================================================
# TYPOGRAPHY
# ============================================================

# 66. TYPOGRAPHY SYSTEM

Reuse project font.

Nếu chưa có:

```css
font-family:
  Inter,
  "Be Vietnam Pro",
  system-ui,
  -apple-system,
  BlinkMacSystemFont,
  "Segoe UI",
  sans-serif;
```

---

# 67. FONT SIZES

Page title:

```txt
32–38px / 750
```

Section title:

```txt
19–22px / 700
```

Card title:

```txt
17–19px / 700
```

Body:

```txt
14–15px
```

Label:

```txt
12–13px / 600
```

Table:

```txt
13–14px
```

---

# ============================================================
# SPACING
# ============================================================

# 68. SPACING SCALE

Chỉ ưu tiên:

```txt
4
8
12
16
20
24
32
40
48
64
```

Page sections:

```txt
24px
```

Card gap:

```txt
20px
```

Card padding:

```txt
20–24px
```

---

# 69. RADIUS

Main section:

```txt
14px
```

Summary:

```txt
14px
```

Tabs:

```txt
12px
```

Inputs:

```txt
8px
```

Buttons:

```txt
8px
```

Badges:

```txt
999px
```

---

# ============================================================
# RESPONSIVE
# ============================================================

# 70. DESKTOP >= 1200

Detail header:

```txt
title left / actions right
```

Summary:

```txt
5–6 items horizontal
```

Tabs:

```txt
single row
```

Scoring:

```txt
2 columns
```

Assets:

```txt
2 columns
```

Members:

```txt
2 columns
```

---

# 71. TABLET 768–1199

Summary:

```txt
3 columns
```

Tabs:

```txt
horizontal scroll
```

Scoring:

```txt
main 60%
side 40%
```

Assets:

```txt
stack if insufficient width
```

Table:

```txt
overflow-x: auto
```

---

# 72. MOBILE < 768

Header:

```txt
back
title + status
slug
actions wrap
```

Summary:

```txt
1–2 columns
```

Tabs:

```css
overflow-x: auto;
white-space: nowrap;
```

Main tab content:

```txt
1 column
```

Tables:

```css
overflow-x: auto;
```

Không cố ép table xuống mobile width.

---

# ============================================================
# OPTIONAL TSX HELPERS
# ============================================================

# 73. BRAND ACCENT COMPONENT

```tsx
export function VKUAccent() {
  return (
    <div
      className="flex items-center gap-1.5"
      aria-hidden="true"
    >
      <span className="h-1 w-7 rounded-full bg-blue-600" />
      <span className="h-1 w-7 rounded-full bg-red-500" />
      <span className="h-1 w-7 rounded-full bg-amber-400" />
    </div>
  );
}
```

---

# 74. BRAND COLOR UTILITY

Chỉ decorative.

```tsx
export type VKUTheme =
  | "blue"
  | "red"
  | "yellow";

export function getVKUTheme(
  index: number
): VKUTheme {
  switch (index % 3) {
    case 0:
      return "blue";

    case 1:
      return "red";

    default:
      return "yellow";
  }
}
```

Không dùng function này cho:

- status
- score
- permission
- lifecycle
- role

---

# 75. SECTION THEME

Nếu dùng Tailwind:

```tsx
export const sectionTheme = {
  blue: {
    border: "border-t-blue-600",
    iconBg: "bg-blue-50",
    iconText: "text-blue-600",
  },

  red: {
    border: "border-t-red-500",
    iconBg: "bg-red-50",
    iconText: "text-red-600",
  },

  yellow: {
    border: "border-t-amber-400",
    iconBg: "bg-amber-50",
    iconText: "text-amber-600",
  },
};
```

Nếu project không dùng Tailwind:

không cài Tailwind.

Convert sang CSS system hiện tại.

---

# ============================================================
# LOADING / ERROR / EMPTY
# ============================================================

# 76. LOADING

Reuse existing query/loading behavior.

Có thể redesign skeleton.

Không fake delay.

---

# 77. ERROR

Reuse existing error behavior.

Không swallow API errors.

Không thay server message nếu có logic mapping hiện tại.

---

# 78. EMPTY STATE

Không tạo dữ liệu giả để UI đầy.

Ví dụ:

nếu chưa có submissions:

render empty state thật.

Nếu chưa có assets:

render empty state thật.

Nếu chưa có members:

render empty state thật.

---

# ============================================================
# ICON SYSTEM
# ============================================================

# 79. ICONS

Reuse icon library hiện tại.

Nếu đang dùng Lucide:

```txt
ArrowLeft
Pencil
Copy
CircleStop
CalendarDays
Users
BarChart3
FileText
Image
Settings
Trophy
Database
KeyRound
Upload
Download
Plus
Trash2
Search
Filter
FileCheck2
CircleCheck
Info
TriangleAlert
MoreHorizontal
```

Không cài package khác nếu không cần.

---

# ============================================================
# ACCESSIBILITY
# ============================================================

# 80. ACCESSIBILITY

Bắt buộc:

- button type đúng
- icon-only button có aria-label
- tab có semantic tab behavior nếu architecture hiện tại hỗ trợ
- focus-visible rõ
- labels cho form
- không biểu diễn status bằng màu duy nhất
- contrast AA hợp lý
- destructive actions rõ ràng

---

# ============================================================
# KHÔNG LÀM
# ============================================================

# 81. FORBIDDEN

KHÔNG:

- rewrite API
- rewrite backend
- rewrite state management
- thay route
- đổi permission
- đổi status logic
- hardcode screenshot values
- tạo dữ liệu demo
- tạo team giả
- tạo submission giả
- tạo asset giả
- tạo leaderboard giả
- đổi scoring metric
- đổi file limits
- đổi Markdown syntax
- đổi ground truth format
- tự thêm feature
- tự thêm chart
- tự thêm KPI
- thêm sidebar
- thêm slogan
- thêm quote
- dùng AI image
- dùng black làm primary CTA
- dùng gray quá nhiều
- làm toàn UI thành màu xanh
- dùng gradient mạnh ở mọi card
- over-engineer component structure

---

# ============================================================
# ACCEPTANCE CRITERIA
# ============================================================

# 82. GLOBAL

- [ ] 5 tabs đồng nhất cùng một Detail Shell.
- [ ] Giữ nguyên toàn bộ business logic.
- [ ] Không hardcode screenshot data.
- [ ] Không thay API.
- [ ] Không thay routes.
- [ ] Không thay permissions.
- [ ] Không tạo dữ liệu demo.
- [ ] Blue/Red/Yellow VKU rõ hơn UI hiện tại.
- [ ] Nền vẫn sạch, không quá màu.
- [ ] Primary CTA dùng VKU Blue.
- [ ] Danger dùng VKU Red.
- [ ] Warning/highlight dùng VKU Yellow.
- [ ] Không dùng black primary buttons.
- [ ] Responsive.
- [ ] Accessibility cơ bản.
- [ ] TypeScript không error.
- [ ] Lint không phát sinh error mới.
- [ ] Build thành công.

---

# 83. CONTENT TAB

- [ ] Table gọn và dễ scan.
- [ ] Thêm trang nội dung = blue CTA.
- [ ] Visibility badge = yellow.
- [ ] Uploaded = green.
- [ ] Edit = blue.
- [ ] Delete = red.
- [ ] Reorder logic giữ nguyên.

---

# 84. ASSETS TAB

- [ ] Upload block blue.
- [ ] Markdown guide yellow.
- [ ] Asset list có red top-accent.
- [ ] Copy action blue.
- [ ] Delete red.
- [ ] File/path monospace.
- [ ] Upload constraints giữ nguyên.

---

# 85. SCORING TAB

- [ ] Main configuration blue.
- [ ] Ground truth card red accent.
- [ ] Format guide yellow accent.
- [ ] Warning yellow.
- [ ] Form không thay behavior.
- [ ] Disabled controls giữ đúng state.
- [ ] Scoring rules không thay đổi.

---

# 86. RESULTS TAB

- [ ] Leaderboard yellow accent.
- [ ] Export button blue.
- [ ] Submission block blue accent.
- [ ] Filters rõ ràng.
- [ ] Metrics lấy từ data thật.
- [ ] Không hardcode F1 nếu competition khác metric.

---

# 87. MEMBERS TAB

- [ ] Join-code card red accent.
- [ ] Key icon yellow.
- [ ] Member panel blue.
- [ ] Change-code button blue.
- [ ] Add-member button blue.
- [ ] Status green.
- [ ] Admin badge blue.
- [ ] Permission logic giữ nguyên.
