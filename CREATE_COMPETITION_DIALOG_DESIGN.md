# CREATE_COMPETITION_DIALOG_DESIGN.md
# VKU AI Challenge — Create Competition Dialog

Scope: Admin → Tạo cuộc thi  
Frontend: React + TypeScript / TSX  
Type: Large modal / dialog form

File này kế thừa:

- VKU_GLOBAL_DESIGN.md
- ADMIN_COMPETITIONS_DESIGN.md

Chỉ redesign UI/UX.
Không thay đổi business logic.

---

# 1. MỤC TIÊU

Redesign dialog:

`Tạo cuộc thi`

theo VKU Design System:

- clean
- modern
- academic
- dễ scan
- dễ hoàn thành form
- không quá nhiều card lồng nhau
- nhận diện Blue / Red / Yellow rõ
- responsive
- keyboard accessible
- code được sạch bằng TSX

Form vẫn là MỘT dialog.

KHÔNG chuyển thành wizard nhiều bước trừ khi business hiện tại đã có.

---

# 2. SOURCE OF TRUTH

SOURCE CODE hiện tại là nguồn sự thật cho:

- fields
- validation
- defaults
- slug generation
- participation mode
- metric
- quota
- leaderboard setting
- date rules
- resource links
- create mutation
- payload
- close behavior
- Esc behavior

Ảnh mockup chỉ là visual reference.

KHÔNG hardcode dữ liệu.

---

# 3. TUYỆT ĐỐI KHÔNG ĐỔI

Không thay:

- API
- POST payload
- field names
- required/optional rules
- validation
- slug behavior
- participation enum
- metric enum
- date calculation
- leaderboard behavior
- Google Drive resource behavior
- create action
- cancel action
- route
- permission

Không đổi `Cần mã tham gia` thành một business mode khác chỉ vì UI.

---

# 4. VẤN ĐỀ UI HIỆN TẠI

Hiện tại:

- modal gần như full screen nhưng chưa có hierarchy tốt
- form dài liên tục
- header khá trống
- section không rõ
- input nào cũng giống nhau
- participation radio card quá lớn
- metric/quota bị tách khỏi scoring context
- leaderboard checkbox giống một form field bình thường
- resource section chưa rõ là repeatable resource list
- footer tốt nhưng chưa đủ brand
- Blue/Red/Yellow VKU chưa rõ

Redesign phải giải quyết các điểm này.

---

# 5. MODAL SIZE

Desktop:

```css
width: min(960px, calc(100vw - 48px));
max-height: min(900px, calc(100vh - 32px));
```

Recommended:

```css
border-radius: 18px;
```

Không để modal sát mép viewport.

---

# 6. OVERLAY

```css
background: rgba(7, 20, 42, 0.42);
backdrop-filter: blur(2px);
```

Nếu project hiện tại không dùng backdrop-filter thì bỏ.

Không dùng overlay đen 80%.

---

# 7. MODAL STRUCTURE

```txt
┌──────────────────────────────────────────────────┐
│ STICKY HEADER                                    │
│                                                  │
│ [icon] CẤU HÌNH CUỘC THI                        │
│        Tạo cuộc thi                              │
│        blue red yellow accent                    │
│                                            [×]   │
├──────────────────────────────────────────────────┤
│ SCROLLABLE BODY                                  │
│                                                  │
│ 01 Thông tin cơ bản                              │
│                                                  │
│ 02 Thời gian                                     │
│                                                  │
│ 03 Cách tham gia                                 │
│                                                  │
│ 04 Chấm điểm & giới hạn                          │
│                                                  │
│ 05 Tài nguyên tải về                             │
│                                                  │
├──────────────────────────────────────────────────┤
│ STICKY FOOTER                                    │
│ Esc hoặc Hủy...                  [Hủy] [Tạo →]   │
└──────────────────────────────────────────────────┘
```

---

# 8. STICKY HEADER

```css
position: sticky;
top: 0;
z-index: 20;

background: rgba(255,255,255,0.97);
border-bottom: 1px solid #E4EAF1;
```

Padding:

```txt
20px 28px
```

---

# 9. HEADER LEFT

Layout:

```txt
[ICON] CẤU HÌNH CUỘC THI
       Tạo cuộc thi
       [blue][red][yellow]
```

---

# 10. HEADER ICON

Suggested:

```txt
Trophy
Settings2
PanelsTopLeft
```

Recommended:

```txt
Trophy
```

Style:

```css
width: 48px;
height: 48px;

border-radius: 12px;

background: #EAF3FF;
color: #0759C7;
```

---

# 11. EYEBROW

Giữ text hiện tại nếu source đang dùng:

```txt
CẤU HÌNH CUỘC THI / COMPETITION SETUP
```

Style:

```css
font-size: 12px;
font-weight: 700;
letter-spacing: 0.06em;
color: #64748B;
```

Không dùng dot xanh đơn độc làm dấu hiệu brand.

---

# 12. DIALOG TITLE

```css
font-size: 28px;
font-weight: 750;
letter-spacing: -0.02em;
color: #0B1F44;
```

---

# 13. VKU HEADER ACCENT

Dưới title:

```txt
──── blue
──── red
──── yellow
```

```css
width: 26px;
height: 4px;
border-radius: 999px;
```

---

# 14. CLOSE BUTTON

```css
width: 38px;
height: 38px;

border-radius: 9px;

background: transparent;
color: #64748B;
```

Hover:

```css
background: #F1F5F9;
color: #0B1F44;
```

Không để dấu X lơ lửng không có hover state.

---

# 15. BODY

```css
overflow-y: auto;
padding: 24px 28px 32px;
```

Background:

```css
background:
  linear-gradient(
    180deg,
    #FFFFFF 0%,
    #FBFCFE 100%
  );
```

---

# 16. FORM SECTIONS

Không dùng 5 card đậm riêng biệt.

Dùng section nhẹ:

```css
padding: 20px 0 24px;
border-bottom: 1px solid #EDF1F5;
```

Section cuối:

```css
border-bottom: 0;
```

---

# 17. SECTION HEADER SYSTEM

Mỗi section:

```txt
[01] [ICON] Thông tin cơ bản
            description ngắn nếu thật sự cần
```

Number chip:

```css
font-size: 11px;
font-weight: 700;
```

---

# 18. SECTION COLOR RHYTHM

```txt
01 Thông tin cơ bản        BLUE
02 Thời gian               RED
03 Cách tham gia           YELLOW
04 Chấm điểm & giới hạn    BLUE
05 Tài nguyên tải về       YELLOW
```

Color chỉ presentation.

Không liên quan business state.

---

# 19. SECTION ICON BLOCK

```css
width: 36px;
height: 36px;
border-radius: 9px;
```

BLUE:

```css
background: #EAF3FF;
color: #0759C7;
```

RED:

```css
background: #FFF1F2;
color: #D30B23;
```

YELLOW:

```css
background: #FFF8DE;
color: #B77900;
```

---

# ============================================================
# SECTION 01 — THÔNG TIN CƠ BẢN
# ============================================================

# 20. SECTION PURPOSE

Bao gồm:

- Tên cuộc thi
- Slug
- Mô tả ngắn

---

# 21. TÊN CUỘC THI

Full width.

```txt
Tên cuộc thi *
[input]
```

Input height:

```txt
46px
```

Không cần input cao 52px như hiện tại.

---

# 22. SLUG

Có thể render:

```txt
Slug *
[input]

URL: /competitions/{slug}
```

Helper text nhỏ hơn:

```css
font-size: 12px;
color: #718096;
```

Nếu slug auto-generated/disabled:

giữ behavior hiện tại.

---

# 23. SLUG VISUAL

Slug input có thể dùng monospace:

```css
font-family:
  "JetBrains Mono",
  Consolas,
  monospace;
```

Không bắt buộc toàn input.

---

# 24. MÔ TẢ NGẮN

```css
min-height: 92px;
resize: vertical;
```

Không để textarea quá cao nếu chỉ là mô tả ngắn.

---

# ============================================================
# SECTION 02 — THỜI GIAN
# ============================================================

# 25. SECTION LAYOUT

Desktop:

```css
display: grid;
grid-template-columns: repeat(2, minmax(0, 1fr));
gap: 18px;
```

Fields:

```txt
Bắt đầu *
Kết thúc *
```

---

# 26. DATE INPUT

Height:

```txt
46px
```

Icon Calendar bên phải.

Focus BLUE.

Không đổi native datetime behavior hiện tại.

---

# 27. TIME VALIDATION

Validation error:

```css
color: #D30B23;
```

Không tự tạo validation rule mới.

---

# ============================================================
# SECTION 03 — CÁCH THAM GIA
# ============================================================

# 28. PARTICIPATION MODES

Các option hiện tại:

```txt
Tự do tham gia
open

Cần mã tham gia
code

Chỉ theo lời mời
invite_only
```

Giữ exact enum/value hiện tại.

---

# 29. OPTION GRID

Desktop:

```css
display: grid;
grid-template-columns: repeat(3, minmax(0, 1fr));
gap: 12px;
```

---

# 30. OPTION CARD SIZE

Giảm chiều cao so với UI hiện tại.

```css
min-height: 82px;
padding: 14px 16px;
```

Không cần radio card gần 100px.

---

# 31. UNSELECTED PARTICIPATION CARD

```css
background: #FFFFFF;
border: 1px solid #DCE3EC;
border-radius: 10px;
```

Hover:

```css
border-color: #9FC5F6;
background: #FAFCFF;
```

---

# 32. SELECTED CARD

Không chỉ dùng blue border.

```css
background:
  linear-gradient(
    135deg,
    #F1F7FF,
    #FFFFFF
  );

border: 1.5px solid #0969E8;

box-shadow:
  0 0 0 3px rgba(9,105,232,0.07);
```

---

# 33. PARTICIPATION ICONS

Optional:

```txt
open        UsersRound
code        KeyRound
invite      MailCheck
```

Color theo VKU:

```txt
Open        BLUE
Code        RED
Invite      YELLOW
```

Nhưng selected state vẫn BLUE structural.

---

# 34. OPTION LABEL

```css
font-size: 14px;
font-weight: 650;
color: #102446;
```

Internal enum/value:

```css
font-size: 11px;
font-family: monospace;
color: #8491A5;
```

Nếu user không cần thấy technical enum:

có thể giữ như current source.

Không tự xóa nếu source đang intentionally hiển thị.

---

# ============================================================
# SECTION 04 — CHẤM ĐIỂM & GIỚI HẠN
# ============================================================

# 35. TWO COLUMN ROW

```txt
Chỉ số chính *                   Giới hạn nộp bài *
[F1                 ▼]          [5              lượt/ngày]
```

Desktop:

```css
grid-template-columns: 1fr 1fr;
gap: 18px;
```

---

# 36. METRIC SELECT

Reuse actual metric options.

Không hardcode chỉ F1.

Input height:

```txt
46px
```

---

# 37. QUOTA INPUT

Suffix:

```txt
lượt / ngày
```

Render suffix trong input group.

Suffix background:

```css
background: #F7F9FC;
```

Divider nhẹ.

---

# 38. LEADERBOARD SETTING

Hiện tại checkbox block đang khá to.

Redesign thành compact setting row.

```txt
┌──────────────────────────────────────────────────────┐
│ [checkbox]  Leaderboard hiển thị với thí sinh       │
│             Nếu tắt, thí sinh sẽ thấy thông báo...  │
└──────────────────────────────────────────────────────┘
```

---

# 39. LEADERBOARD SETTING STYLE

```css
padding: 15px 16px;

background:
  linear-gradient(
    90deg,
    #F5F9FF,
    #FFFFFF
  );

border: 1px solid #DDE6F1;
border-left: 3px solid #0969E8;

border-radius: 10px;
```

Không cần card cao lớn.

---

# 40. CHECKBOX

Checked:

VKU Blue.

```css
accent-color: #0759C7;
```

Nếu custom checkbox:

reuse current component.

---

# ============================================================
# SECTION 05 — TÀI NGUYÊN TẢI VỀ
# ============================================================

# 41. SECTION TITLE

```txt
Tài nguyên tải về
```

Không nhất thiết nhét `(link Google Drive)` vào heading.

Có thể để mô tả:

```txt
Thêm liên kết Google Drive hoặc tài nguyên tải về cho thí sinh.
```

NHƯNG chỉ nếu không làm thay đổi nghĩa.

---

# 42. CURRENT HELPER TEXT

Giữ thông tin nghiệp vụ hiện tại như:

```txt
Chỉ nhận link Google Drive...
```

nếu source thực sự có.

Style thành INFO NOTE.

---

# 43. RESOURCE INFO NOTE

Theme YELLOW:

```css
background: #FFFBEB;
border: 1px solid #F5DE91;
border-left: 3px solid #F5B800;

border-radius: 8px;

padding: 12px 14px;
```

Không để helper text là paragraph trôi nổi.

---

# 44. RESOURCE EMPTY STATE

Nếu chưa có:

```txt
Chưa có tài nguyên nào.
```

muted.

Không cần card riêng quá lớn.

---

# 45. ADD RESOURCE BUTTON

Current:

```txt
+ Thêm tài nguyên
```

Redesign:

```css
height: 42px;

background: #FFFFFF;

border: 1px dashed #9CBDE5;
border-radius: 9px;

color: #0759C7;
```

Hover:

```css
background: #F4F8FF;
border-color: #0969E8;
```

Không black.

---

# 46. RESOURCE ROW

Nếu user thêm resource:

```txt
Tên tài nguyên
[...................]

Google Drive URL
[...................]

                            [Xóa]
```

Hoặc preserve exact fields currently implemented.

Do not invent fields.

---

# 47. DELETE RESOURCE

RED subtle:

```css
background: #FFF5F5;
color: #D30B23;
```

---

# ============================================================
# INPUT SYSTEM
# ============================================================

# 48. LABEL

```css
font-size: 13px;
font-weight: 650;
color: #102446;
```

Required `*`:

```css
color: #D30B23;
```

---

# 49. INPUT

```css
height: 46px;

background: #FFFFFF;

border: 1px solid #DCE3EC;
border-radius: 9px;

padding: 0 14px;

font-size: 14px;
color: #102446;
```

---

# 50. INPUT FOCUS

```css
border-color: #0969E8;

box-shadow:
  0 0 0 3px rgba(9, 105, 232, 0.10);
```

---

# 51. INPUT DISABLED

```css
background: #F3F5F7;
color: #8491A5;
```

---

# 52. INPUT ERROR

```css
border-color: #EC1631;

box-shadow:
  0 0 0 3px rgba(236,22,49,0.08);
```

Message:

```css
font-size: 12px;
color: #D30B23;
```

---

# ============================================================
# FOOTER
# ============================================================

# 53. STICKY FOOTER

```css
position: sticky;
bottom: 0;
z-index: 20;

background: rgba(255,255,255,0.97);

border-top: 1px solid #DFE5EC;

padding: 14px 28px;
```

---

# 54. FOOTER LAYOUT

Desktop:

```txt
Esc hoặc Hủy để đóng hộp thoại.                 [Hủy] [Tạo →]
```

---

# 55. FOOTER HELPER

```css
font-size: 12px;
color: #718096;
```

Có thể thêm keyboard-style:

```txt
Esc
```

nhưng không bắt buộc.

---

# 56. CANCEL BUTTON

```css
height: 44px;

background: #FFFFFF;
color: #172B4D;

border: 1px solid #D7DFE9;
border-radius: 9px;
```

---

# 57. CREATE BUTTON

Primary VKU Blue.

```css
height: 44px;

padding-inline: 20px;

background:
  linear-gradient(
    135deg,
    #0759C7,
    #0969E8
  );

color: #FFFFFF;

border: 1px solid #0759C7;
border-radius: 9px;

font-weight: 650;
```

Text:

```txt
Tạo  →
```

Giữ wording hiện tại.

---

# 58. CREATE HOVER

```css
background: #064BAB;

box-shadow:
  0 5px 14px rgba(7,89,199,0.18);
```

---

# 59. CREATE LOADING

Reuse mutation state.

Ví dụ:

```txt
Đang tạo...
```

hoặc spinner theo current component.

Không cho double submit.

---

# ============================================================
# SCROLL
# ============================================================

# 60. MODAL SCROLL

Chỉ BODY scroll.

Header/footer không scroll.

Không để toàn dialog di chuyển khiến CTA biến mất.

---

# 61. SCROLLBAR

Nếu custom scrollbar hiện có:

reuse.

Nếu không:

không cần thêm dependency.

Có thể CSS nhẹ:

```css
scrollbar-width: thin;
scrollbar-color: #B8C5D6 transparent;
```

---

# ============================================================
# VKU BRAND DECORATION
# ============================================================

# 62. HEADER BACKGROUND DETAIL

Có thể dùng decorative geometry rất nhẹ:

```txt
top-right:
light blue diagonal

small:
red stripe
yellow stripe
```

Opacity:

```txt
5–8%
```

---

# 63. KHÔNG ĐỂ NỀN MODAL QUÁ NHIỀU HỌA TIẾT

Form cần readability cao.

VKU identity nằm ở:

- header
- section accents
- icons
- selected controls
- CTA
- info notes

Không đặt background colorful sau input.

---

# ============================================================
# RESPONSIVE
# ============================================================

# 64. TABLET

< 900px:

Modal:

```css
width: calc(100vw - 24px);
```

Two-column field grids có thể giữ nếu đủ rộng.

Participation 3 cards:

có thể wrap thành:

```txt
2 + 1
```

---

# 65. MOBILE

< 640px:

Modal gần full viewport:

```css
width: 100vw;
height: 100dvh;
max-height: 100dvh;

border-radius: 0;
```

---

# 66. MOBILE FIELD LAYOUT

Tất cả:

```txt
1 column
```

Participation:

```txt
1 card / row
```

Footer:

```txt
[Hủy] [Tạo]
```

Actions vẫn luôn visible.

---

# ============================================================
# ACCESSIBILITY
# ============================================================

# 67. DIALOG SEMANTICS

Phải giữ:

```txt
role="dialog"
aria-modal="true"
aria-labelledby
```

nếu current modal library xử lý thì reuse.

---

# 68. FOCUS

On open:

focus field đầu tiên hợp lý.

Current screenshot đang focus:

```txt
Tên cuộc thi
```

Đây là behavior tốt.

Giữ.

---

# 69. FOCUS TRAP

Reuse dialog library hiện tại.

Không tự implement focus trap nếu library đã có.

---

# 70. ESC

Giữ:

```txt
Esc đóng dialog
```

nếu current behavior đã như vậy.

Nếu form dirty và hiện tại có confirm:

giữ confirm.

Không tự thêm confirm nếu business chưa có.

---

# 71. RADIO ACCESSIBILITY

Participation options vẫn phải là semantic radio group.

Visual card KHÔNG được biến thành div-only click handler.

---

# 72. LABEL ACCESSIBILITY

Mọi input:

label chính xác.

Required state:

```txt
aria-required
```

nếu component hiện tại dùng.

---

# ============================================================
# COMPONENT STRUCTURE
# ============================================================

# 73. RECOMMENDED COMPONENTS

Không bắt buộc nếu code hiện tại đã tốt.

```txt
CreateCompetitionDialog
│
├── DialogHeader
├── DialogBody
│   ├── FormSection
│   │
│   ├── BasicInfoSection
│   ├── TimingSection
│   ├── ParticipationSection
│   ├── ScoringSection
│   └── ResourcesSection
│
└── DialogFooter
```

---

# 74. GENERIC FORMSECTION

Có thể tạo:

```tsx
interface FormSectionProps {
  index: string;
  title: string;
  icon: React.ReactNode;
  tone: "blue" | "red" | "yellow";
  children: React.ReactNode;
}
```

Nếu dùng nhiều section.

Đây là abstraction hợp lý.

---

# 75. KHÔNG OVER-COMPONENTIZE

Không tạo:

```txt
CompetitionDialogLabel
CompetitionDialogDescription
CompetitionDialogFieldContainer
CompetitionDialogFieldGridCell
...
```

nếu shared form components đã có.

---

# ============================================================
# FORBIDDEN
# ============================================================

# 76. TUYỆT ĐỐI KHÔNG

- Không đổi field.
- Không đổi payload.
- Không đổi enum.
- Không đổi metric.
- Không đổi participation logic.
- Không đổi validation.
- Không đổi date rules.
- Không đổi quota rules.
- Không đổi leaderboard behavior.
- Không đổi resource behavior.
- Không tạo wizard.
- Không tạo thêm bước xác nhận nếu source không có.
- Không black primary CTA.
- Không giant radio cards.
- Không gradient rực quanh toàn modal.
- Không fake data.
- Không thêm field banner/logo nếu source chưa có.
- Không thêm cover image upload.
- Không thêm template competition nếu feature chưa tồn tại.

---

# ============================================================
# ACCEPTANCE CRITERIA
# ============================================================

# 77. DIALOG

- [ ] Header sticky.
- [ ] Footer sticky.
- [ ] Chỉ body scroll.
- [ ] VKU identity rõ.
- [ ] Blue/Red/Yellow có nhịp.
- [ ] Không quá màu.
- [ ] Modal dễ scan.
- [ ] Không còn cảm giác một form dài liên tục.

---

# 78. BASIC INFO

- [ ] Tên rõ.
- [ ] Slug rõ.
- [ ] URL helper gọn.
- [ ] Mô tả không quá cao.
- [ ] Không đổi slug behavior.

---

# 79. TIME

- [ ] Start/end cùng hàng desktop.
- [ ] Date control đồng nhất.
- [ ] Validation giữ nguyên.

---

# 80. PARTICIPATION

- [ ] 3 options rõ.
- [ ] Selected state rõ.
- [ ] Options không quá cao.
- [ ] Semantic radio giữ nguyên.
- [ ] enum/business giữ nguyên.

---

# 81. SCORING

- [ ] Metric + quota cùng nhóm.
- [ ] Leaderboard setting gọn.
- [ ] Không đổi scoring logic.
- [ ] Không hardcode F1.

---

# 82. RESOURCES

- [ ] Helper chuyển thành info note.
- [ ] Add resource rõ.
- [ ] Empty state gọn.
- [ ] Không đổi Google Drive behavior.

---

# 83. ACTIONS

- [ ] Hủy = neutral.
- [ ] Tạo = VKU Blue.
- [ ] Loading state giữ đúng.
- [ ] Không double submit.

---

# 84. QUALITY

- [ ] Desktop responsive.
- [ ] Tablet responsive.
- [ ] Mobile responsive.
- [ ] Keyboard accessible.
- [ ] TypeScript pass.
- [ ] Lint không lỗi mới.
- [ ] Build pass.
