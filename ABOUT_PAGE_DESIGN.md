# ABOUT_PAGE_DESIGN.md

# VKU AI Challenge - Trang Giới thiệu

> Design specification cho trang:
>
> `Giới thiệu`
>
> File này kế thừa:
>
> - `VKU_GLOBAL_DESIGN.md`
> - design system chung của VKU AI Challenge
>
> Đây là UI/UX redesign.
> Không thay đổi dữ liệu, nội dung nghiệp vụ hoặc routing.

---

# 1. MỤC TIÊU

Thiết kế lại trang `Giới thiệu` theo phong cách:

- Modern academic
- Technology-oriented
- VKU-branded rõ ràng
- Clean
- Sáng
- Professional
- Thông tin dễ scan
- Ít cảm giác "trang Word"
- Responsive
- React + TypeScript / TSX friendly

Trang phải đồng bộ trực quan với:

- Cuộc thi
- Quản trị cuộc thi
- Chi tiết cuộc thi
- Tài khoản
- Hỗ trợ & Liên hệ

Nhưng vì đây là trang giới thiệu, có thể sử dụng:

- Blue
- Red
- Yellow

rõ ràng hơn một chút so với các trang quản trị.

Không biến trang thành poster.

---

# 2. VẤN ĐỀ CỦA UI HIỆN TẠI

UI hiện tại có các vấn đề:

- nội dung giống văn bản Word được đổ trực tiếp lên web
- paragraph dài
- hierarchy yếu
- rất ít visual anchor
- thiếu VKU identity
- khoảng trắng chưa được sử dụng hiệu quả
- các nhóm thông tin chưa được chia rõ
- CTA chưa nổi bật
- title và body không tạo được nhịp đọc
- chưa đồng bộ với các page VKU đã redesign

Redesign phải giải quyết các điểm này.

---

# 3. SOURCE OF TRUTH

SOURCE CODE / CONTENT hiện tại là nguồn sự thật.

Ảnh mockup chỉ là visual reference.

KHÔNG hardcode các nội dung từ mockup nếu source không có.

Ví dụ không tự thêm:

```txt
Proud to be VKUers
AI FOR A BRIGHTER TOMORROW
Công nghệ kiến tạo giá trị
Con người làm nên tương lai
Kết nối tri thức - Kiến tạo tương lai
```

trừ khi đây là nội dung chính thức có trong:

- source
- asset
- brand guideline
- content hiện tại

---

# 4. KHÔNG BỊA NỘI DUNG

Không tự tạo:

- slogan
- số liệu
- thành tích
- lịch sử
- đối tác
- giải thưởng
- testimonial
- timeline
- logo đối tác
- campus photo
- banner marketing
- fake contact
- fake statistics
- fake mission statement

Chỉ bố trí lại content thật hiện có.

---

# 5. PAGE STRUCTURE

Desktop:

```txt
┌────────────────────────────────────────────────────────────┐
│ GLOBAL NAVBAR                                              │
├────────────────────────────────────────────────────────────┤
│                                                            │
│ HERO                                                       │
│                                                            │
│ [ICON] Giới thiệu                     optional decoration  │
│        subtitle                                            │
│        ─ blue ─ red ─ yellow                              │
│                                                            │
├────────────────────────────────────────────────────────────┤
│                                                            │
│ ┌───────────────────────────────┐ ┌──────────────────────┐ │
│ │                               │ │                      │ │
│ │ VỀ NỀN TẢNG AI CHALLENGE      │ │ ĐƠN VỊ & ĐẦU MỐI   │ │
│ │                               │ │ HỖ TRỢ               │ │
│ │ Platform intro                │ │                      │ │
│ │ Public access                 │ │ VKU                  │ │
│ │ Account                      │ │ KHCN & HTQT          │ │
│ │ Rules & submissions          │ │ Technical support    │ │
│ │                               │ │                      │ │
│ ├───────────────────────────────┤ │ info note            │ │
│ │                               │ └──────────────────────┘ │
│ │ VKU - ĐƠN VỊ CHỦ TRÌ         │                        │
│ │                               │ ┌──────────────────────┐ │
│ │ Full name                     │ │ BẮT ĐẦU KHÁM PHÁ    │ │
│ │ University system             │ │                      │ │
│ │ Established                   │ │ CTA                  │ │
│ │ Mission                       │ │                      │ │
│ │ Address                       │ └──────────────────────┘ │
│ └───────────────────────────────┘                          │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

---

# 6. DESKTOP MAIN GRID

```css
.about-main-grid {
  display: grid;
  grid-template-columns:
    minmax(0, 1.6fr)
    minmax(340px, 0.95fr);

  gap: 20px;
  align-items: start;
}
```

Left:

```txt
Về nền tảng AI Challenge
VKU - đơn vị chủ trì
```

Right:

```txt
Đơn vị và đầu mối hỗ trợ
Bắt đầu khám phá
```

Không tạo sidebar navigation.

---

# 7. PAGE CONTAINER

```css
.about-container {
  width: min(calc(100% - 48px), 1440px);
  margin-inline: auto;
}
```

Không dùng container quá hẹp như UI cũ.

---

# 8. PAGE BACKGROUND

```css
.about-page {
  min-height: 100vh;

  background:
    linear-gradient(
      180deg,
      #F6FAFF 0,
      #F8FAFC 250px,
      #F8FAFC 100%
    );
}
```

Không pure white toàn trang.

---

# 9. NAVBAR

Reuse navbar chung.

Không tạo navbar riêng.

Active nav:

```txt
Giới thiệu
```

Style:

```css
background: #EAF3FF;
color: #0759C7;
border-bottom: 2px solid #0969E8;
```

---

# 10. HERO

Hero của trang Giới thiệu có thể brand-rich hơn trang Hỗ trợ.

Mục tiêu:

- rõ VKU identity
- vẫn clean
- không quá marketing

Desktop:

```txt
150–190px
```

---

# 11. HERO LAYOUT

```txt
LEFT                                      RIGHT

[ICON] Giới thiệu                        optional official visual
       subtitle                          / abstract VKU decoration
       blue red yellow accent
```

---

# 12. HERO TITLE

```css
font-size: clamp(32px, 2.7vw, 40px);
font-weight: 760;
letter-spacing: -0.03em;
color: #0B1F44;
```

---

# 13. HERO SUBTITLE

Giữ nguyên text hiện tại.

Ví dụ source hiện tại:

```txt
Nền tảng tổ chức các cuộc thi AI của
Trường Đại học Công nghệ Thông tin và Truyền thông Việt - Hàn,
Đại học Đà Nẵng.
```

Không rewrite nếu không được yêu cầu.

Style:

```css
max-width: 650px;

font-size: 15px;
line-height: 1.65;
color: #53627A;
```

---

# 14. HERO ICON

Suggested nếu dùng Lucide:

```txt
Landmark
University
Sparkles
Layers3
```

Recommended:

```txt
Landmark
```

Style:

```css
width: 62px;
height: 62px;

display: grid;
place-items: center;

border-radius: 15px;

background: #EAF3FF;
border: 1px solid #C8DFFF;

color: #0759C7;
```

---

# 15. VKU THREE-COLOR ACCENT

Dưới subtitle.

```tsx
<div className="vku-accent" aria-hidden="true">
  <span className="blue" />
  <span className="red" />
  <span className="yellow" />
</div>
```

```css
.vku-accent {
  display: flex;
  gap: 5px;
  margin-top: 14px;
}

.vku-accent span {
  width: 30px;
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

# 16. HERO BRAND DECORATION

Hero có thể sử dụng nhiều hơn 3 màu VKU.

Recommended:

```txt
LEFT edge:
blue diagonal
red diagonal
yellow diagonal

RIGHT:
subtle blue geometry
yellow strip
small red accent
```

Opacity vừa phải.

Không làm che text.

---

# 17. OFFICIAL VKU IMAGE

Nếu repo đã có asset ảnh tòa nhà VKU chính thức:

có thể sử dụng ở hero.

Style:

```css
opacity: 0.55–0.75;
object-fit: cover;
mask/fade into background;
```

Không để ảnh giống banner poster.

Nếu không có asset thật:

dùng abstract geometry.

Không tạo fake AI campus image trong production.

---

# 18. HERO COLOR BALANCE

Hero có thể có nhiều brand hơn:

```txt
BLUE     ~60%
RED      ~20%
YELLOW   ~20%
```

Không để yellow trở thành background toàn hero.

---

# 19. MAIN CARD BASE

```css
.about-card {
  background: #FFFFFF;

  border: 1px solid #DFE5EC;
  border-radius: 14px;

  box-shadow:
    0 1px 2px rgba(15, 23, 42, 0.02),
    0 6px 22px rgba(15, 23, 42, 0.035);
}
```

---

# 20. MÀU CỦA CÁC MAIN BLOCK

Để VKU identity rõ:

```text
Về nền tảng AI Challenge   → BLUE
VKU - đơn vị chủ trì       → RED
Đơn vị & đầu mối hỗ trợ    → YELLOW
Bắt đầu khám phá           → BLUE + RED/YELLOW decoration
```

Không dùng neutral gray cho tất cả block.

---

# 21. CARD COLOR RULE

Không tô toàn bộ card.

Dùng:

```css
border-top: 3px solid <brand-color>;
```

hoặc left accent nhẹ.

Card body vẫn:

```txt
WHITE
```

---

# ============================================================

# BLOCK 1 - VỀ NỀN TẢNG AI CHALLENGE

# ============================================================

# 22. PLATFORM CARD

Theme:

```txt
BLUE
```

```css
border-top: 3px solid #0969E8;
```

---

# 23. PLATFORM HEADER

```txt
[Layers icon] Về nền tảng AI Challenge
              short description optional
```

Icon:

```css
background: #EAF3FF;
color: #0969E8;
```

---

# 24. PLATFORM CONTENT

Không render thành:

```txt
bold title. paragraph
bold title. paragraph
bold title. paragraph
```

liên tục như UI cũ.

Chuyển thành grouped feature items.

---

# 25. PLATFORM FEATURE LAYOUT

Desktop trong card:

```css
display: grid;
grid-template-columns: repeat(2, minmax(0, 1fr));
gap: 18px 24px;
```

Nếu số mục ít:

có thể 1 column.

---

# 26. PLATFORM FEATURE ITEM

Structure:

```txt
[ICON] Title
       Description
```

Ví dụ content từ source hiện tại:

```txt
Một website, nhiều cuộc thi
Đọc công khai
Tài khoản
Thể lệ và bài nộp
```

Giữ nội dung thật.

---

# 27. PLATFORM FEATURE ICON COLORS

Để tăng blue/red/yellow:

```txt
Feature 1 → BLUE
Feature 2 → BLUE
Feature 3 → RED
Feature 4 → YELLOW
```

Chỉ decorative.

---

# 28. BLUE FEATURE ICON

```css
background: #EAF3FF;
color: #0969E8;
```

---

# 29. RED FEATURE ICON

```css
background: #FFF1F2;
color: #EC1631;
```

---

# 30. YELLOW FEATURE ICON

```css
background: #FFFBEB;
color: #D89600;
```

---

# 31. FEATURE TITLE

```css
font-size: 14px;
font-weight: 680;
color: #102446;
```

---

# 32. FEATURE DESCRIPTION

```css
font-size: 13px;
line-height: 1.6;
color: #64748B;
```

---

# 33. KHÔNG THÊM FEATURE

Không tự thêm:

```txt
AI analytics
Realtime ranking
Smart scoring
Cloud storage
```

nếu source không có.

---

# ============================================================

# BLOCK 2 - VKU ĐƠN VỊ CHỦ TRÌ

# ============================================================

# 34. VKU HOST CARD

Theme:

```txt
RED
```

```css
border-top: 3px solid #EC1631;
```

Lý do:

giúp page có nhịp màu rõ thay vì toàn blue.

---

# 35. VKU HOST HEADER

```txt
[University icon] VKU - đơn vị chủ trì
                  full institution name
```

Icon:

```css
background: #FFF1F2;
color: #D30B23;
```

---

# 36. HOST INFORMATION

Hiện tại source có các nhóm như:

```txt
Tên đầy đủ
Đại học Đà Nẵng
Thành lập
Sứ mệnh
Địa chỉ
```

Không render thành paragraph liên tục.

---

# 37. HOST INFORMATION LIST

Structure:

```txt
[icon] Tên đầy đủ
       value

[icon] Đại học Đà Nẵng
       value

[icon] Thành lập
       value

...
```

---

# 38. HOST ICONS

Possible icons:

```txt
GraduationCap
Users
CalendarDays
Star
MapPin
```

Reuse existing package.

---

# 39. HOST ICON STYLE

Không cần mỗi item một màu lớn.

Recommended:

```css
color: #50658A;
```

Hoặc alternating subtle:

```txt
Blue / neutral / red / yellow
```

---

# 40. HOST LABEL

```css
font-size: 13px;
font-weight: 680;
color: #102446;
```

---

# 41. HOST VALUE

```css
font-size: 13px;
line-height: 1.6;
color: #53627A;
```

---

# ============================================================

# BLOCK 3 - ĐƠN VỊ VÀ ĐẦU MỐI HỖ TRỢ

# ============================================================

# 42. SUPPORT ORGANIZATION CARD

Theme:

```txt
YELLOW
```

```css
border-top: 3px solid #F5B800;
```

---

# 43. SUPPORT CARD HEADER

```txt
[Users icon] Đơn vị và đầu mối hỗ trợ
             subtitle
```

Icon:

```css
background: #EAF3FF;
color: #0969E8;
```

Không bắt buộc icon yellow.

---

# 44. SUPPORT ITEMS

Source hiện tại có thể gồm:

```txt
Trường VKU
Phòng Khoa học Công nghệ - Hợp tác Quốc tế
Người hỗ trợ kỹ thuật
```

Giữ chính xác source.

---

# 45. SUPPORT ITEM PRESENTATION

Mỗi đầu mối:

```txt
[ICON] Organization / person
       Role / description
```

Sub-card:

```css
padding: 14px 16px;

border: 1px solid #E5EAF0;
border-radius: 10px;

background: #FFFFFF;
```

Gap:

```txt
10–12px
```

---

# 46. SUPPORT ICONS

Suggested:

```txt
Building2
UsersRound
Settings
```

Icon blocks:

```css
background: #EAF3FF;
color: #0969E8;
```

Có thể dùng:

```txt
one blue
one yellow
one red
```

nếu nhìn cân bằng.

---

# 47. CONTACT NOTE

Nếu source có:

```txt
Thông tin liên hệ đầy đủ ở trang Hỗ trợ & Liên hệ.
```

render thành info note.

Recommended theme:

```txt
YELLOW
```

```css
background: #FFF9E8;
border: 1px solid #F5D66C;
border-left: 4px solid #F5B800;

color: #9A6000;
```

Không duplicate toàn bộ email/phone tại đây nếu trang Hỗ trợ đã có.

---

# ============================================================

# BLOCK 4 - BẮT ĐẦU KHÁM PHÁ

# ============================================================

# 48. CTA CARD

Đây là call-to-action cuối page.

Không dùng black button.

Theme:

```txt
BLUE with RED/YELLOW decoration
```

---

# 49. CTA CARD STYLE

```css
border-top: 3px solid #0969E8;

background:
  linear-gradient(
    135deg,
    #FFFFFF 0%,
    #F7FAFF 100%
  );
```

Có thể có:

```txt
red/yellow decorative corners
```

---

# 50. CTA HEADER

```txt
[Arrow / Trophy icon]

Bắt đầu khám phá
```

Nếu source hiện tại chỉ có:

```txt
Bắt đầu
```

có thể giữ `Bắt đầu`.

Không tự rewrite wording nếu muốn giữ tuyệt đối source.

---

# 51. CTA DESCRIPTION

Dùng nội dung hiện tại nếu có.

Không tạo marketing copy mới.

---

# 52. CTA BUTTON

Source hiện tại:

```txt
Xem danh sách cuộc thi
```

Primary:

```css
height: 46px;

background: #0759C7;
color: #FFFFFF;

border: 1px solid #0759C7;
border-radius: 9px;

padding-inline: 20px;

font-weight: 650;
```

Hover:

```css
background: #064BAB;
```

---

# 53. CTA COLOR ALTERNATIVE

Nếu muốn tăng red brand:

có thể dùng RED accent ở icon/card decoration.

Không đổi CTA chính sang red nếu không có lý do semantic.

Primary navigation action vẫn BLUE.

---

# 54. RED/YELLOW CTA DECORATION

Có thể dùng ở góc:

```txt
blue diagonal
yellow diagonal
red diagonal
```

nhỏ.

Không cản content.

---

# 55. KHÔNG TẠO SECONDARY CTA

Không tự thêm:

```txt
Liên hệ ngay
Đăng ký
Tìm hiểu thêm
```

nếu source không có.

---

# 56. INFORMATION DENSITY

Main goal:

chuyển từ:

```txt
wall of text
```

sang:

```txt
small grouped information
```

Không rút ngắn content quan trọng.

Chỉ thay layout.

---

# 57. CARD PADDING

Desktop:

```txt
22–24px
```

Tablet/mobile:

```txt
16–20px
```

---

# 58. SECTION GAP

```txt
20px
```

Main page vertical:

```txt
24px
```

---

# 59. TYPOGRAPHY

Page title:

```txt
32–40px / 750
```

Main card title:

```txt
19–22px / 700
```

Sub-section title:

```txt
14–16px / 650–700
```

Body:

```txt
13–15px
```

---

# 60. RESPONSIVE - LARGE DESKTOP

>= 1200px

```txt
Hero horizontal
Main grid 60/40 approximately
Feature grid 2 columns
```

---

# 61. RESPONSIVE - TABLET

768–1199px

Main grid:

```css
grid-template-columns: 1fr;
```

Order:

```txt
Về nền tảng
VKU đơn vị chủ trì
Đơn vị hỗ trợ
CTA
```

Hoặc giữ right content xen kẽ nếu architecture hợp lý.

Recommended:

stack theo logical reading order.

---

# 62. RESPONSIVE - MOBILE

<768px:

```txt
Hero
Platform
VKU host
Support
CTA
```

Single column.

Feature grid:

```txt
1 column
```

Card padding:

```txt
16px
```

---

# 63. MOBILE HERO

Không hiển thị ảnh hero lớn nếu chiếm không gian quá nhiều.

Official image có thể:

```txt
hide
```

hoặc:

```txt
small faded background
```

Text luôn ưu tiên.

---

# 64. ICON SIZE

Section icon:

```txt
22–24px
```

Feature:

```txt
20–22px
```

---

# 65. GLOBAL COLOR RHYTHM

Final:

```text
HERO                        BLUE + RED + YELLOW

PLATFORM CARD               BLUE

PLATFORM FEATURES
  platform                  BLUE
  public access             BLUE
  account                   RED
  rules/submission          YELLOW

VKU HOST CARD               RED

SUPPORT CARD                YELLOW

SUPPORT ITEM ICONS          BLUE dominant

INFO NOTE                   YELLOW

CTA CARD                    BLUE
CTA decoration              RED + YELLOW
```

Điều này đảm bảo trang nhìn rõ màu VKU mà không biến thành poster.

---

# 66. BORDER COLORS

Do not use full saturated color border around cards.

Only:

```css
border: 1px solid #DFE5EC;
border-top: 3px solid <brand-color>;
```

---

# 67. BACKGROUND BRAND COLOR

Large red/yellow backgrounds:

KHÔNG.

Use:

```text
5–10% tint
```

cho icon/background decorations.

---

# 68. NO BLACK PRIMARY CTA

Không:

```txt
[ Xem danh sách cuộc thi ]
background black
```

Phải dùng:

```txt
VKU Blue
```

---

# 69. NO EXTRA FOOTER

Nếu app hiện tại đã có global footer:

reuse.

Nếu chưa có:

không tự tạo.

Mockup footer không phải requirement.

---

# 70. NO FAKE SLOGAN

Mockup có thể có slogan vì mục đích thiết kế.

Production:

chỉ render slogan nếu source/repo chính thức có.

---

# 71. NO FAKE IMAGE

Không đưa AI-generated VKU campus vào production.

Chỉ dùng:

- official existing repository asset
- known public asset already in project
- abstract decoration

---

# 72. PAGE INTERACTIONS

Trang Giới thiệu gần như static.

Không cần:

- animations phức tạp
- carousel
- counter
- auto-scroll
- timeline animation

---

# 73. HOVER

Chỉ subtle:

```css
transition:
  border-color 160ms ease,
  background-color 160ms ease,
  box-shadow 160ms ease;
```

Không translate cards nhiều.

---

# 74. ACCESSIBILITY

Required:

- proper heading hierarchy
- CTA = semantic link/button
- official link clear
- icons decorative `aria-hidden`
- keyboard focus
- contrast
- no essential info only by color

---

# 75. SUGGESTED COMPONENT STRUCTURE

Nếu architecture phù hợp:

```txt
AboutPage
│
├── AboutHero
│
├── AboutMainGrid
│   │
│   ├── PlatformOverviewCard
│   │   └── PlatformFeature
│   │
│   ├── VKUHostCard
│   │
│   ├── SupportOrganizationsCard
│   │
│   └── ExploreCompetitionsCard
```

Không over-componentize.

---

# 76. PLATFORM FEATURE DATA

Nếu current markup đang viết từng paragraph:

có thể refactor thành:

```tsx
type PlatformFeature = {
  title: string;
  description: React.ReactNode;
  icon?: React.ReactNode;
  tone?: "blue" | "red" | "yellow";
};
```

Nhưng content phải giữ nguyên.

---

# 77. HOST DATA

Có thể refactor presentation thành:

```tsx
type HostInfoItem = {
  label: string;
  value: React.ReactNode;
};
```

Không chuyển data sang hardcoded duplicate nếu đã nằm trong API/config.

---

# 78. SUPPORT DATA

Có thể normalize:

```tsx
type SupportUnit = {
  title: string;
  description?: string;
};
```

Nếu phù hợp.

---

# 79. DO NOT OVER-ENGINEER

Trang này static/information-heavy.

Không cần:

```txt
state manager
custom context
design engine
CMS abstraction
```

chỉ để redesign.

---

# 80. BEFORE / AFTER INTENT

Before:

```txt
Title
paragraph
huge card
paragraph
paragraph
paragraph
divider
paragraph
paragraph
...
```

After:

```txt
Branded hero

Platform overview
  feature
  feature
  feature
  feature

VKU host
  structured information

Support units
  structured cards

Explore CTA
```

---

# 81. FORBIDDEN

TUYỆT ĐỐI KHÔNG:

- fake slogan
- fake campus asset
- fake statistics
- fake history
- fake achievements
- fake support unit
- fake contact
- add partners
- add logos not in source
- black primary CTA
- all-blue UI
- all-red UI
- saturated yellow backgrounds
- huge poster banner
- giant unused whitespace
- plain wall of paragraphs
- rewrite source meaning
- change routes
- change navbar logic
- add new API

---

# 82. ACCEPTANCE CRITERIA

Trang chỉ hoàn thành khi:

- [ ] Đồng nhất với VKU_GLOBAL_DESIGN.
- [ ] Navbar đúng global system.
- [ ] Giới thiệu active rõ.
- [ ] Hero có blue/red/yellow identity.
- [ ] Hero không quá lớn.
- [ ] Content không còn wall-of-text.
- [ ] Platform information được chia thành feature items.
- [ ] Không làm mất content.
- [ ] Platform block = blue accent.
- [ ] VKU block = red accent.
- [ ] Support block = yellow accent.
- [ ] CTA block = blue + red/yellow decoration.
- [ ] Primary CTA không black.
- [ ] Không fake content.
- [ ] Không fake image.
- [ ] Không fake slogan.
- [ ] Không thay route.
- [ ] Responsive desktop/tablet/mobile.
- [ ] TypeScript pass.
- [ ] Lint không có lỗi mới.
- [ ] Production build pass.

---

# 83. FINAL VISUAL CHARACTER

Trang Giới thiệu cần cho cảm giác:

```text
VKU
+
ACADEMIC
+
AI / TECHNOLOGY
+
CLEAN
+
CONFIDENT
+
STRUCTURED
+
BLUE RED YELLOW
```

không phải:

```text
marketing landing page
```

và cũng không phải:

```text
plain documentation page
```

Nó nằm ở giữa:

```text
Institutional About Page
+
Modern Technology Platform
```

---

# PHỤ LỤC A - ĐIỀU CHỈNH CHO REPOSITORY NÀY

Phần trên là đặc tả thiết kế. Phụ lục này ghi lại hai điểm mà bản đặc tả phải điều chỉnh cho khớp với source code thật và các quyết định đã có của repo. Hai điểm này không nới lỏng bất kỳ mục FORBIDDEN nào.

## A.1. Trần rộng 1440px áp ở shell, không lặp trong trang

Đặc tả §7 viết `.about-container { width: min(calc(100% - 48px), 1440px) }`. Trang `/ho-tro` đã chốt cách khác và cách đó được `VKU_GLOBAL_DESIGN.md` §9 cho phép: trần rộng do class của `<main>` quyết định, còn thân trang chỉ căn giữa.

Vì vậy `/gioi-thieu` dùng đúng pattern đó:

```css
.app-main-about {
  max-width: var(--container-wide);
}
```

```css
.about-page {
  width: 100%;
  margin-inline: auto;
}
```

Không đặt `max-width` lần thứ hai bên trong trang, và không đổi `--container` toàn cục. Padding ngang vẫn do shell quyết định (`--page-padding-inline`). Đây là ngoại lệ page-specific, giống `/ho-tro`; `App.test.tsx` phải chứng minh class này không rò sang route khác.

## A.2. "Nguồn thông tin" là card thứ năm bắt buộc

Đặc tả §5 vẽ bốn block chính. Tuy nhiên `/gioi-thieu` **phải** giữ khối "Nguồn thông tin":

- ADR-022 (`docs/DECISIONS.md`) ghi rõ `/gioi-thieu` **giữ** khối "Nguồn thông tin" (không bỏ mất nguồn).
- `frontend/src/pages/AboutPage.test.tsx` đang khoá danh sách URL nguồn.
- `docs/TEST_MATRIX.md` ghi bất biến này ở mục 9e.

Vì đặc tả §56 yêu cầu "không làm mất content" và §81 cấm bỏ sót nguồn, khối này được render thành **card thứ năm, full-width, nằm cuối grid**:

- giữ heading cùng bốn link nguồn với `rel="noopener noreferrer nofollow"`;
- dùng accent neutral (`--vku-border`), không gán màu thương hiệu thứ tư - bốn màu xanh/đỏ/vàng/xanh của bốn block chính đã khoá nhịp màu;
- danh sách trải hai cột ở desktop để nhãn ngắn không bị kéo căng hết chiều rộng card.

**Điều chỉnh ngày 2026-09-18 (theo yêu cầu trực tiếp của user):**

- Bỏ câu dẫn "Thông tin về VKU được tổng hợp từ các nguồn chính thức dưới đây, truy cập ngày…". Hằng `SOURCE_ACCESSED` không còn nơi dùng nên đã xoá khỏi `frontend/src/lib/vkuInfo.ts`.
- Thêm nguồn thứ tư: trang **Phòng KHCN - HTQT** (`https://vku.udn.vn/vi/co-cau-to-chuc/phong-khoa-hoc-cong-nghe-hop-tac-quoc-te/`, nhãn `Phòng KHCN - Hợp tác Quốc tế`). Đây **không phải** nguồn bịa thêm - `VKU_SOURCES.department` đã có sẵn và đang dùng ở `/ho-tro`; URL đổi sang biến thể `/vi/` do user cung cấp nên `/ho-tro` cũng dùng URL mới.
- Cả bốn nhãn rút về tên ngắn 2–6 chữ (`Giới thiệu Trường`, `Liên hệ`, `Phòng KHCN - Hợp tác Quốc tế`, `Đại học Đà Nẵng`) thay vì dán tiền tố domain. Hệ quả đã chấp nhận: mất tín hiệu cho biết link ra `vku.udn.vn` hay `udn.vn`; bù lại bằng `target="_blank"` và heading `Nguồn thông tin`.

Bố cục desktop đầy đủ:

```txt
┌─────────────────────────────────────────┬──────────────────────┐
│ VỀ NỀN TẢNG AI CHALLENGE   (BLUE)       │ ĐƠN VỊ & ĐẦU MỐI    │
│                                         │ HỖ TRỢ      (YELLOW) │
├─────────────────────────────────────────┤                      │
│ VKU - ĐƠN VỊ CHỦ TRÌ        (RED)        ├──────────────────────┤
│                                         │ BẮT ĐẦU      (BLUE)  │
│                                         │                      │
└─────────────────────────────────────────┴──────────────────────┘
┌─────────────────────────────────────────────────────────────────┐
│ NGUỒN THÔNG TIN                        (NEUTRAL, full-width)     │
└─────────────────────────────────────────────────────────────────┘
```

## A.3. Icon

Repo không có icon package và `VKU_GLOBAL_DESIGN.md` §3 cấm thêm package. Vì vậy các icon gợi ý ở §14/§23/§38/§46 (Landmark, Layers, GraduationCap, Building2…) được vẽ bằng SVG inline theo convention sẵn có: `viewBox="0 0 24 24"`, `fill="none"`, `stroke="currentColor"`, `aria-hidden="true"`, `focusable="false"`. Không dùng Lucide.

## A.4. Ảnh VKU

Repo chỉ có một asset ảnh chính thức: `frontend/public/vku-logo.png`, và nó đã được dùng ở global header. Không có ảnh campus chính thức trong repo. Theo §17 và §71, hero dùng hình học CSS trừu tượng; không tạo và không lấy ảnh từ mockup.
