# MARKDOWN_RENDERER_DESIGN.md - VKU Markdown Document Renderer

Contract cho **một renderer Markdown duy nhất** dùng cho mọi cuộc thi và mọi tài liệu `.md`
trong nội dung cuộc thi. Tài liệu này mô tả **hợp đồng render**; bảng token, typography,
radius, breakpoint và accessibility dùng nguyên `VKU_GLOBAL_DESIGN.md` §5–§10 và
`frontend/src/index.css` - không định nghĩa lại.

## 1. Phạm vi

- Nguồn duy nhất render Markdown: `frontend/src/markdown/MarkdownView.tsx`.
- Nơi dùng duy nhất: `frontend/src/pages/CompetitionContentPanel.tsx` (tab nội dung của trang
  chi tiết cuộc thi). Trang admin không có preview Markdown.
- **Markdown là source of truth.** Renderer không sửa, không format lại, không tự đánh số,
  không tự thêm heading/section/nhãn, không suy diễn nội dung nghiệp vụ.

## 2. Pipeline

```text
ContentDetail.markdown  (string nguyên bản từ API)
  → ReactMarkdown                       react-markdown@10
      remarkPlugins  = [remark-gfm]     bảng, task list, strikethrough, autolink
      rehypePlugins  = [rehype-sanitize]  schema mặc định - KHÔNG rehype-raw
      urlTransform   = src  → resolveMarkdownAssetUrl(src, competitionSlug)
                       khác → defaultUrlTransform của react-markdown
      components     = heading | pre | img | a | table
  → CSS .markdown-body / .md-*
```

Không parse Markdown bằng regex ở bất kỳ đâu. Regex chỉ được dùng để **validate URL/tên file**
trong `resolveMarkdownAssetUrl`. Không thêm parser, syntax highlighter, UI framework hay
dependency mới.

## 3. Matrix element → HTML → class

| Markdown | HTML render | Class / ghi chú |
|---|---|---|
| `#` … `######` | `h2` … `h6` (hạ một bậc) | `.markdown-body h2..h6` |
| paragraph | `p` | `.markdown-body p` |
| `**bold**` / `*italic*` | `strong` / `em` | không đổi sang element khác |
| `-` / `1.` | `ul`/`ol` > `li` | marker xanh cho `ul`, đỏ cho `ol` |
| `- [x]` | `ul.contains-task-list` > `li.task-list-item` | checkbox thật, `disabled` (GFM) |
| `~~x~~` | `del` | muted, vẫn rõ |
| `` `code` `` | `code` ngoài `pre` | mono, chữ VKU red |
| ```` ```lang ```` | `div.md-code-block` > `div.md-code-head` + `pre > code` | xem §5 |
| `>` | `blockquote` | callout chung, không nhãn |
| bảng GFM | `div.md-table-wrap[role=region]` > `table` | xem §6 |
| `![alt](src)` | `img` hoặc `span.md-image-fallback` | xem §4 |
| `---` | `hr` | vạch ba màu |
| link | `a` | xem §7 |

Heading bị hạ một bậc là **bắt buộc**: H1 của trang là tên cuộc thi ở masthead. Vì vậy bốn cấp
heading tác giả (`#`, `##`, `###`, `####`) lần lượt render thành `h2`, `h3`, `h4`, `h5`.

## 4. Asset ảnh

Canonical syntax là `assets/<tên-file>`. Hai alias `./assets/<tên-file>` và
`../assets/<tên-file>` được normalize về cùng một đích. Sau normalize, đường dẫn phải là **đúng
một basename phẳng** vì endpoint `GET /api/competitions/{slug}/assets/{name}`
(`backend/app/content/router.py`) không nhận `/`.

`resolveMarkdownAssetUrl(src, slug)` là nơi duy nhất biết hợp đồng này:

- chỉ ba alias trên; mọi thứ khác (scheme, `//`, `/`, traversal, thư mục con, query, fragment,
  percent-encoding, backslash, tên ẩn) → `null`;
- extension chỉ `.png .jpg .jpeg .gif .webp`, khớp `ASSET_TYPES` của
  `backend/app/content/storage.py`;
- thành công → `/api/competitions/${slug}/assets/${basename}`, thất bại → `null`.

Hệ quả phía UI:

- `src` bị từ chối → **không render `<img>`**, không tạo request, hiển thị
  `.md-image-fallback` kèm mô tả alt/title nếu có.
- `src` hợp lệ nhưng endpoint trả lỗi (`onError`) → cùng placeholder đó.
- Không có `onLoad`/spinner; ảnh dùng `loading="lazy"`.

Cú pháp **không** hợp lệ CommonMark (escape `\!`, thụt 4 spaces thành code block, fence sai)
vẫn render thành code/text theo đúng đặc tả CommonMark. Renderer không "sửa" các trường hợp này
vì làm vậy sẽ phá Markdown chuẩn và vi phạm nguyên tắc không sửa nội dung.

## 5. Code block

- Wrapper `.md-code-block` (navy `--code-surface`, accent vàng trên đỉnh).
- Toolbar `.md-code-head` **nằm ngoài `<pre>`**: nhãn ngôn ngữ `.md-code-lang` + button
  `.md-code-copy`.
- Ngôn ngữ lấy từ class `language-*` **đã sanitize** và phải qua allowlist trước khi hiển thị;
  không có thì dùng nhãn UI chung. Không suy diễn ý nghĩa nghiệp vụ từ nội dung.
- Nội dung `<pre><code>` là **chính `children` đã parse** - ký tự `_`, `*`, `[]`, tree glyph và
  khoảng trắng giữ nguyên. Clipboard copy lấy text từ cây đó và chỉ bỏ newline cuối.
- Copy dùng `navigator.clipboard.writeText(...).then(onSuccess, onFailure)`; thành công đổi
  nhãn sang "Đã sao chép" trong thời gian ngắn và thông báo qua `role="status"`; thất bại hoặc
  trình duyệt không cho phép thì hiện hướng dẫn sao chép thủ công, **không** unmount code.
- `<pre>` chỉ cuộn ngang (`overflow-x: auto`), không wrap. Inline code không đi qua component này.

## 6. Bảng

Wrapper `.md-table-wrap` là `role="region"`, `tabIndex=0`, `aria-label="Bảng dữ liệu"` và cuộn
ngang; bên trong vẫn là `<table>` ngữ nghĩa nguyên vẹn - không đổi `display`, không biến hàng
thành card.

## 7. URL và link

- `urlTransform` cho mọi thuộc tính khác `src` gọi `defaultUrlTransform` của react-markdown
  (allowlist scheme), nên `javascript:` / `data:text/html` không sống trong DOM.
- Link `http(s)` được thêm `target="_blank"` + `rel="noopener noreferrer"`; link nội bộ không bị
  ép mở tab.
- Raw HTML không được bật (`rehype-sanitize` là safety net, không có `rehype-raw`).

## 8. Accessibility

- Đúng **một H1** mỗi trang (masthead cuộc thi); heading tài liệu bắt đầu từ H2.
- Semantic giữ nguyên: `table`, `pre > code`, `blockquote`, `ul/ol/li`.
- Mọi ảnh có `alt`; placeholder giữ mô tả trong text hiển thị (không đọc icon hai lần).
- Button copy là `<button type="button">` có tên truy cập, điều khiển được bằng bàn phím, focus
  ring không bị `overflow: hidden` cắt, touch target ≥ 44px trên màn nhỏ.
- Contrast chữ thường ≥ 4.5:1; trạng thái không chỉ biểu diễn bằng màu.

## 9. Responsive

| Bề rộng | Quy tắc |
|---|---|
| base (≥ 375px) | padding gọn, heading nhỏ hơn, toolbar code không tràn |
| ≥ 48rem | tăng cỡ heading và nhịp dọc |
| mọi bề rộng | `pre`/`.md-table-wrap` cuộn nội bộ; `img` `max-width: 100%`; `documentElement` không overflow |

Surface tài liệu là `.card.comp-body` trong `.comp-page` (68rem) - không thêm card/container
lồng nhau. Light mode only (`color-scheme: light`), không animation.

## 10. Non-goals

- Không raw HTML, `rehype-raw`, alert/`[!NOTE]` plugin, heading anchor, TOC mới.
- Không tự đánh số heading, không tự sinh nhãn "Lưu ý", file card, gallery, banner, logo.
- Không hardcode nội dung/dữ liệu của bất kỳ cuộc thi nào (SMARTCITY, dataset, tên file, số mục).
- Không syntax highlighting, không dark mode, không animation.
- Không đổi content API, asset endpoint, quyền asset, storage, auth, route hay metadata trang.

Ảnh mockup chỉ là **tham chiếu thị giác** cho hierarchy, nhịp dọc, code panel, table/callout/image.
Các thành phần đặc thù trong mockup chỉ xuất hiện nếu chính Markdown của tác giả chứa dữ liệu
tương ứng.
