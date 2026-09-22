# Data Model - AI Challenge Platform

Nguộc sự thật về MongoDB collections và indexes. Trạng thái `implemented` = có code tạo/migration + được dùng thật; `planned` = baseline từ `plans/02_ARCHITECTURE_CONTRACTS.md`, chưa code.

Quy ước chung:
- Thời gian lưu UTC trong DB; UI format theo local timezone.
- Motor đọc về naive datetime: mọi chỗ so sánh/format đi qua `backend/app/core/datetimes.py` (`as_utc`, `utc_day_bounds`, `iso_z`), naive được hiểu là UTC (ADR-016).
- Naming snake_case.
- Mọi dữ liệu nghiệp vụ gắn `competition_id` (ADR-005).
- Files không nằm trong Mongo: content Markdown, asset và ground truth theo layout `/data/` ở `plans/01_MASTER_CONTEXT.md` §11; artifact của submission (CSV dự đoán + notebook) nằm trong MinIO private (ADR-028), key ghép từ slug theo ADR-033.

## 1. accounts - implemented (Sprint 02)

Fields:
- `_id` (ObjectId)
- `email` (login identifier, lưu lowercase, strip)
- `name`
- `password_hash` (Argon2id, argon2-cffi defaults)
- `role`: `admin` | `participant`
- `active`: bool - khóa toàn nền tảng (disable hủy hiệu lực mọi session)
- `slug` (str | absent ở account cũ) - dùng làm segment đường dẫn artifact trên MinIO (ADR-033). Sinh tự động từ `name` ở **lần nộp bài đầu tiên**, không nhập tay, không bao giờ sinh lại (đổi `name` không đổi slug). Trùng thì thêm `-` + 3 ký tự random. Không có trong representation nào trả về API.
- `created_at`, `updated_at` (UTC, timezone-aware)

Indexes:
- unique trên `email` - tạo idempotent ở app startup (`ensure_indexes`)
- unique **sparse** trên `slug` - sparse để account cũ chưa có field này không cùng rơi vào giá trị null và chặn nhau (ADR-033)

## 2. sessions - implemented (Sprint 02)

Fields:
- `_id`: sha256 hex của raw session token (token gốc là `secrets.token_urlsafe(32)`, chỉ tồn tại trong cookie)
- `account_id` (ObjectId → accounts._id)
- `created_at` (UTC, timezone-aware)
- `expires_at` (UTC, timezone-aware)

Indexes:
- TTL trên `expires_at` (`expireAfterSeconds=0`) - tạo idempotent ở app startup
- `account_id`

Lưu ý: Mongo TTL chỉ dọn định kỳ; `resolve_session` vẫn check `expires_at` từng request nên session hết hạn bị từ chối ngay.

## 3. competitions - implemented (Sprint 03)

Fields:
- `_id` (ObjectId)
- `slug` (unique) - format `[a-z0-9]+(-[a-z0-9]+)*`, tối đa 64 ký tự, immutable sau tạo
- `name`
- `short_description`
- `status`: `draft` | `published` | `closed` - lifecycle: draft → published → closed ⇄ published (`/reopen`). Xoá được ở `draft` và `closed`. Xem ADR-009 + ADR-027
- `start_at`, `end_at` (UTC, timezone-aware; API nhận ISO, trả ISO `...Z`)
- `join_mode`: `open` | `code` | `invite_only`
- `join_code_hash` (luôn None ở Sprint 03 - join là Sprint 04; không bao giờ trả về API)
- `primary_metric`: `f1` | `precision` | `recall`
- `quota_per_day` (0-1000)
- `leaderboard_visible` (bool)
- `resources` (list, default `[]` | absent ở document cũ) - link Google Drive cho participant tải, xem §9
- `scoring_config` (object | absent) - Sprint 05; chỉ chứa CSV/metric behavior, xem §7
- `ground_truth` (object | absent) - Sprint 05; metadata/path private, xem §8
- `created_by` (email của admin tạo) - chỉ trả trong represent admin, không bao giờ lộ cho guest/participant (ADR-016)
- `created_at`, `updated_at` (UTC, timezone-aware)

Indexes:
- unique trên `slug` - tạo idempotent ở app startup (`ensure_indexes`)

Derived field (không lưu DB):
- `submission_count` - **không** là field của document. `GET /api/competitions` chạy một aggregation `$match competition_id` + `$group _id` trên `submissions` cho cả trang rồi gắn vào từng item (ADR-032). Đếm mọi document submission đã persist, không phụ thuộc `status` **lẫn `review`**, nên bài bị reject (không tạo document) không được tính, còn bài đã persist mà admin từ chối thì vẫn tính - nó vẫn là một lượt đã tiêu (ADR-035). Không migration, không index mới: index có prefix `competition_id` của `submissions` (§6) đã phục vụ `$match` này. Detail và endpoint admin không dùng lại field này - admin đã có `submission_count` từ `activity_counts`.

## 4. competition_memberships - implemented (Sprint 04)

Fields:
- `_id` (ObjectId)
- `competition_id` (ObjectId → competitions._id)
- `account_id` (ObjectId → accounts._id)
- `active`: bool - khóa trong riêng một competition (participant không tự kích hoạt lại; admin reactivate giữ `joined_at`). Từ ADR-018, participant tự đặt `false` bằng `POST /leave` (soft deactivate); admin xoá cứng được bằng `DELETE .../members/{account_id}` **chỉ khi** account chưa có bài `completed` - document bị xoá hẳn trong trường hợp đó.
- `joined_at` (UTC, timezone-aware)
- `updated_at` (UTC, timezone-aware)
- `submission_seq` (int | absent ở membership cũ) - counter cấp `submission_no` cho cặp (cuộc thi, account) này, tăng nguyên tử bằng `$inc` **trước** khi upload (ADR-033). Membership chưa có thì lần cấp đầu tiên seed bằng `submission_no` lớn nhất đã cấp cho cặp đó; số nhảy cách nếu upload fail sau khi đã cấp.
- `quota_day` (str `YYYY-MM-DD` UTC | absent ở membership cũ) + `quota_used` (int | absent) - bộ đếm lượt nộp theo ngày, nguồn sự thật của hạn mức thay cho phép đếm submission (ADR-034). `quota_used` chỉ được tăng/giảm qua `find_one_and_update` có điều kiện nên không bao giờ vượt `quota_per_day`; sang ngày mới (hoặc membership chưa có field) thì seed lại từ số bài `completed` thật trong ngày. Bài không ghi được (upload/insert lỗi) được trả lại lượt.

Indexes:
- unique compound `(competition_id, account_id)` - enforce race-safe idempotent join
- `account_id` - batch lookup membership cho dashboard

## 5. competition_contents - implemented (Sprint 04)

Fields:
- `_id` (ObjectId - sinh trước insert, dùng làm tên file)
- `competition_id` (ObjectId)
- `title`
- `slug` (format như competition slug, unique trong competition)
- `order` (int 0-9999, default max+10)
- `visibility`: `public` (mọi account đã đăng nhập) | `members` (membership active)
- `markdown_path` (relative trong DATA_DIR: `competitions/<cid>/content/<content_id>.md` - backend sinh, không dùng input user)
- `size_bytes` (int | null - null = chưa upload file)
- `created_at`, `updated_at` (UTC, timezone-aware)

Indexes:
- unique `(competition_id, slug)`
- sort `(competition_id, order)`

## 5b. Competition assets (filesystem, không có collection)

`<DATA_DIR>/competitions/<competition_id>/assets/<uuid4>.<ext>` - PNG/JPEG/GIF/WebP ≤2 MiB (sniff magic bytes, không SVG). List bằng cách đọc directory (số lượng nhỏ); serve qua API có authz + `nosniff`.

## 5c. Starter notebook (asset đóng gói, không có collection)

`backend/app/competitions/starter_notebook.ipynb` là **một** tệp cố định nằm trong image backend (Dockerfile `COPY app ./app`), phục vụ ở `/api/starter-notebook`. Không có document Mongo, không có bản sao theo cuộc thi, không ghi vào `competitions.resources` và admin không sửa được qua API - đổi notebook là đổi code rồi deploy (ADR-030). Không chạy/không render nội dung này ở server.

## 6. submissions - implemented (Sprint 05; artifact trên MinIO từ ADR-028)

Fields:
- `_id`
- `competition_id`
- `account_id`
- `submission_no` (int | absent ở record cũ) - số thứ tự thật của bài nộp theo `(competition_id, account_id)`, dùng làm token trong tên file khi tải **và** trong object key trên MinIO. Từ ADR-033 số được cấp trước khi upload từ counter `submission_seq` của membership; record tạo trước ADR-028 không có field này.
- `artifacts` (object | absent ở record cũ) - hai artifact của lượt nộp, mỗi kind một entry:
  - `prediction` / `notebook`: `{object_key, original_filename, size_bytes}`
  - `object_key` là đường dẫn trong bucket MinIO `submission-artifacts`, không bao giờ trả về API (chỉ `filename`/`size_bytes`/`available` đi ra qua `artifact_metadata`)
- `file_path` (chỉ record cũ) - CSV trên persistent disk theo layout ADR-003; vẫn đọc được khi tải, không có migration bắt buộc
- `original_filename` (chỉ record cũ, đi cùng `file_path`)
- `status`: `completed` (chỉ persist bài validation/scoring thành công)
- `metrics`: `{f1, precision, recall}` raw float
- `primary_score`
- `created_at`
- `review` (object | absent ở record cũ) - quyết định xét duyệt **hậu kiểm** của admin, là trục **độc lập** với `status` (ADR-035):
  - `status`: `rejected` | `accepted`
  - `note` (str | null) - lý do từ chối, participant đọc được; luôn `null` khi `accepted`
  - `reviewed_by` (ObjectId → accounts._id), `reviewed_at` (UTC, timezone-aware)
  - Ghi **cả object** trong một `$set` trên một document nên không bao giờ trộn metadata của hai lần xét duyệt; chỉ giữ quyết định **gần nhất**, không có event history. `reviewed_by`/`reviewed_at` không bao giờ đi ra endpoint participant.
- `content_snapshot` (object | absent) - bản thể lệ **bất biến** đã chốt tại thời điểm nộp, chỉ có khi AI bật lúc submit (ADR-036): `{state: "CAPTURED" | "ERROR", revision_id, content_hash, error_code, captured_at}`. `ERROR` ghi lại sự thật là không chụp được (`CONTENT_EMPTY` | `CONTENT_SNAPSHOT_TOO_LARGE` | `CONTENT_CHANGED_DURING_CAPTURE` | `CONTENT_UNREADABLE`) chứ **không** chặn lượt nộp; bài không chụp được thì không chạy lại AI được và admin thấy banner giải thích.
- `ai_review` (object | absent) - trục trạng thái AI, **độc lập** với `status` và `review` (ADR-036): `{state: "QUEUED" | "RUNNING" | "COMPLETED" | "ERROR", verdict: "CLEAR" | "FLAGGED" | "INCONCLUSIVE" | "ERROR" | null, summary, participant_summary, generation, run_id, latest_review_id, requested_at, updated_at}`. Chỉ có khi `auto_review=true` hoặc admin đã chạy tay; `auto_review=false` vẫn chụp revision nhưng **không** tạo projection/job. Snapshot lỗi + auto ⇒ `state/verdict="ERROR"` với `run_id` cố định để reconciler bảo đảm có audit row, và **không** tạo job gọi provider. Không có field nào ở đây ảnh hưởng `metrics`, `primary_score`, `status` hay tư cách xếp hạng.
  - `participant_summary` (str | null, ADR-040) - **gợi ý ngắn do model soạn nháp cho thí sinh**, tối đa 10 từ, chỉ admin đọc. Nó **không** đi ra endpoint participant: `participant_projection` vẫn thay summary bằng câu cố định theo verdict, và chữ duy nhất tới tay thí sinh vẫn là `review.note` do người duyệt gửi (ADR-035). `null` khi model không có gì để nói; `request_manual_review` **xoá** field này cùng lúc reset projection để gợi ý của lượt cũ không sống dậy sau khi chạy lại.
- `artifacts.notebook.sha256` (str | absent ở record cũ) - SHA-256 của **bytes notebook gốc** lúc nộp, ghi ngay khi insert để cache/audit không phải đọc lại MinIO chỉ để định danh; worker vẫn băm lại bytes đã lưu khi xử lý và coi đó là nguồn sự thật.

Policy: validation-rejected không tạo record và file không được lưu (ADR-011). Một lượt nộp hợp lệ cần **cả** CSV lẫn notebook; thiếu một trong hai thì không upload object nào và không tiêu quota. `quota_remaining` là response-derived field, không lưu DB. Hạn mức/ngày đọc từ bộ đếm `quota_day`/`quota_used` trên membership (§4), seed từ số bài `completed` theo `created_at` trong ngày UTC khi sang ngày mới (ADR-034).

Document thiếu `review` (mọi record cũ và mọi bài chưa từng bị xét duyệt) mặc định là **được tính kết quả**: predicate dùng chung là `status == "completed" AND review.status != "rejected"`, và `$ne` khớp cả document thiếu field nên **không cần migration hay backfill**. Từ chối và khôi phục đều không đụng `status`, `metrics`, `primary_score`, `artifacts`, `submission_no`, `created_at` hay counter quota - nhờ vậy quota, scoring lock, bảo vệ xoá member và việc giữ artifact giữ nguyên hành vi; khôi phục cũng không chấm lại vì metrics đã nằm trong document.

Artifact mới **không** nằm dưới `<DATA_DIR>`: object key là `competitions/<slug cuộc thi>/accounts/<slug account>/submissions/submission-0001/prediction.csv|notebook.ipynb`, bucket private, chỉ FastAPI đọc/ghi (ADR-028, layout slug từ ADR-033). Token `submission-{no:04d}` sinh từ cùng một hàm với tên file tải về nên hai chỗ không lệch nhau. Record tạo trước ADR-033 giữ nguyên key theo ObjectId (`competitions/<id>/accounts/<id>/submissions/<id>/…`) vì `object_key` lưu nguyên văn trong document - **không có migration**, hai layout cùng tồn tại. Xoá cuộc thi dọn **cả hai** prefix `competitions/<slug>/` và `competitions/<id>/`; xoá member dọn object của các bài chưa `completed` - xem §10.

Indexes:
- unique partial `(competition_id, account_id, submission_no)` (`submission_no` tồn tại) - chốt số thứ tự, record legacy không tham gia ràng buộc
- `(competition_id, account_id, created_at DESC, _id DESC)` - participant history exact sort
- `(competition_id, primary_score)`
- `(competition_id, status, primary_score DESC, created_at ASC, account_id ASC, _id ASC)` - leaderboard completed/best-score exact sort
- `(competition_id, status, created_at DESC, _id DESC)` - admin history có status filter
- `(competition_id, created_at DESC, _id DESC)` - admin history không filter status
- `(created_at DESC, _id DESC)` - trang `/admin/submissions` toàn cục sắp xếp không kèm `competition_id`
- `(primary_score DESC, created_at DESC, _id DESC)` - sắp xếp theo điểm ở trang toàn cục
- `(ai_review.state, created_at DESC, _id DESC)` - vòng reconcile/pending của worker
- `(ai_review.verdict, created_at DESC, _id DESC)` - bộ lọc AI của bảng admin

Hai index AI là index **thường**, không phải partial: `mongomock` không hỗ trợ đầy đủ biểu thức partial nên test sẽ không kiểm được đúng thứ production chạy. Đổi lại, document thiếu `ai_review` vẫn được index với khoá `null` - chi phí chấp nhận được ở quy mô này, và bộ lọc `none` (`$exists: false`) không đi qua index mà quét trên tập đã thu hẹp bởi `competition_id`/`status`.

Khác với `review` (ADR-035: "thêm index khi có bằng chứng đo được, không thêm trước"), hai index AI được tạo **ngay** vì chúng phục vụ một vòng quét nền chạy liên tục trên toàn bộ collection, không phải một truy vấn admin thỉnh thoảng: reconciler và worker phải tìm được job/submission đang chờ mà không table-scan mỗi vòng. Leaderboard và export **không** dùng chúng - hai đường đó vẫn đi qua prefix `competition_id` + `status` rồi lọc `review` trên tập đã thu hẹp, và không có điều kiện nào về AI trong `eligible_query()`.

Sắp xếp của trang toàn cục: `created_at` (default, desc) và `primary_score` dùng index ở trên; `team` sắp theo **tên account** nên phải `$lookup` sang `accounts`, `competition` sắp theo tên rồi slug nên `$lookup` sang `competitions` (ADR-029). Hai metric còn lại (`f1`, `precision`, `recall`) sắp trực tiếp trên `metrics.<field>` và không có index riêng: đây là đường quản trị phụ, thêm ba index nữa không đáng so với chi phí ghi. Mọi kiểu sort đều kết thúc bằng tie-break `created_at` rồi `_id` để phân trang không trùng/mất dòng.

`stats` của trang toàn cục là **derived**, không lưu DB và không có collection riêng: một aggregation `$facet` trên cùng query filter trả về `total`, số `competition_id` khác nhau, số `account_id` khác nhau và số document **được tính kết quả** (`status=completed` + `review.status != rejected`) - nên nhãn của thẻ này là "Được tính kết quả", không phải "Đã chấm điểm" (ADR-035). Route theo một cuộc thi vẫn dùng `count_documents` và không chạy aggregation này.

Sprint 06 không thêm field persistence. My Submissions, leaderboard, admin view và export đều là dữ liệu derived từ `submissions` + safe account fields. `total_submissions` chỉ đếm record **được tính kết quả**, nhất quán với ADR-011 và ADR-035.

## 7. Scoring config (embedded trong competitions)

`competitions.scoring_config`:
- `id_column`, `prediction_column`, `label_column`
- `average`: `binary` | `macro` | `weighted`
- `pos_label` (nếu binary)
- `higher_is_better`: `true` (MVP)

Không lưu `scoring_config.json`. `primary_metric` và `quota_per_day` dùng top-level competition fields hiện có. `MAX_UPLOAD_MB` chỉ đến từ environment, không lưu Mongo (ADR-011).

## 8. Ground truth metadata (embedded trong competitions)

`competitions.ground_truth`:
- `path`: relative `competitions/<competition_id>/private/ground_truth.csv`
- `row_count`
- `columns`: danh sách header, không chứa row/label values
- `uploaded_at` (UTC)

File thật private trên persistent disk. Scoring ready khi có `scoring_config`, metadata path hợp lệ và file thường tồn tại (không chấp nhận symlink). Config/ground truth khóa khi competition closed hoặc có submission completed.

Readiness dùng cho publish là **một** hàm dùng chung (`backend/app/scoring/readiness.py`) đọc và parse lại ground truth thật, không chỉ kiểm tra file tồn tại (ADR-017).

## 9. Competition resources (embedded trong competitions)

`competitions.resources`: list `{label, url}`, tối đa 10 phần tử, label ≤120 ký tự, url ≤2048 ký tự và phải là `https` trên `drive.google.com`/`docs.google.com` (không credentials). Đây là link ngoài, không phải file trên hệ thống - không có collection, không có thư mục trong `<DATA_DIR>` (ADR-015).

Document tạo trước thay đổi này không có field; serializer trả `[]` nên không cần migration Mongo. `clone` copy nguyên list.

## 10. Deletion semantics (ADR-018)

Không dùng Mongo transaction (standalone). Thứ tự xoá luôn là con trước – cha sau để lỗi giữa đường vẫn còn bản ghi gốc cho lần gọi lại:

- `DELETE /api/admin/competitions/{id}` (`draft` + `closed`; `published` → 409 `COMPETITION_NOT_DELETABLE`): `ai_review_jobs` → `ai_reviews` → `submissions` → `competition_memberships` → `competition_contents` → `competition_content_revisions` → `competitions` (ADR-036 chèn ba collection AI vào đúng vị trí tham chiếu của chúng: job và audit row đứng trước `submissions` vì cùng trỏ vào nó, revision đứng sau vì bị `submissions`/`ai_reviews` tham chiếu), sau đó best-effort `rmtree` hai root `<DATA_DIR>/competitions/<id>` và `<DATA_DIR>/submissions/<id>` **và** dọn hai prefix MinIO `competitions/<slug>/` + `competitions/<id>/` (ADR-028, ADR-033). Một bước dọn lỗi ⇒ `files_removed:false`, DB đã xoá xong. `accounts` và `sessions` không bị đụng.
- `DELETE /api/admin/competitions/{id}/members/{account_id}`: xoá record submission chưa `completed` của account (kèm object MinIO/file legacy, best-effort) rồi xoá membership cuối cùng. Bài `completed` không bao giờ bị xoá - vướng thì trả 409 và dừng.
- `POST /api/competitions/{slug}/leave`: chỉ `update` `active=false`, không xoá gì.

Xoá competition `published` không có trong phạm vi: cuộc thi đang chạy phải Kết thúc trước. `draft` và `closed` xoá được (cascade), nên "đã kết thúc" không phải là bảo đảm còn dữ liệu - muốn giữ lịch sử thi thì đừng xoá (ADR-027).

## 11. AI Notebook Review (ADR-036)

Kiểm tra notebook bằng AI là trục trạng thái **thứ ba**, chạy bất đồng bộ và **chỉ tham khảo**. Ba collection dưới đây không tham gia `eligible_query()`, không chứa điểm, và xoá chúng không làm đổi kết quả cuộc thi.

### 11.1 `competitions.ai_review_config` (embedded, ADR-036)

Field optional; document tạo trước ADR-036 không có nó nên mặc định là **tắt**.

```text
enabled: bool                         default false
auto_review: bool                     default true
participant_visible: bool             default true
provider: "openai_compatible"         hằng số, không có biến thể Anthropic
base_url: str                         đã chuẩn hoá, không trailing slash
model: str
api_key_ciphertext: str | absent      token Fernet; KHÔNG BAO GIỜ trả ra API
verified_at: datetime | absent        lần cuối gọi provider thành công (ADR-043)
verified_fingerprint: str | absent    sha256 của cấu hình đã dùng lúc đó (ADR-043)
updated_by: ObjectId → accounts._id
updated_at: datetime
```

Quy tắc ghi:
- PUT dùng dotted `$set` cho từng field công khai, **không** ghi đè cả object - ghi đè cả object sẽ nuốt mất ciphertext đang có.
- `api_key` vắng mặt hoặc chuỗi rỗng = giữ key cũ; xoá key chỉ qua `DELETE .../ai-review/api-key` bằng `$unset`.
- `transfer_acknowledgement` là trường của cơ chế xác nhận chuyển dữ liệu **đã bỏ ở ADR-042**. Mọi lần PUT đều `$unset` nó, nên document cũ tự sạch sau lần ghi kế tiếp.
- `verified_at`/`verified_fingerprint` chỉ do `POST .../ai-review/test` chạm, và chỉ khi body **rỗng** (probe bằng chính cấu hình đã lưu): thành công ghi cả hai, hỏng `$unset` cả hai. Vân tay băm `(phiên bản, base_url, model, api_key_ciphertext)`; `public_config` trả `verified_at` **chỉ khi** vân tay còn khớp, nên không đường ghi nào phải nhớ xoá vết - đổi một trong ba trường là vết tự hết hiệu lực. Document cũ thiếu hai field được đọc như "chưa từng xác minh", không cần migration.
- `enabled=true` đòi URL/model/key hợp lệ. Readiness này **không** tham gia publish/scoring readiness: cuộc thi publish được dù AI cấu hình sai.

### 11.2 `competition_content_revisions` - bản thể lệ bất biến

```text
_id: ObjectId
competition_id: ObjectId
content_hash: str                     SHA-256 hex của canonical payload
pages: [
  {content_id, title, slug, order, visibility: "public"|"members",
   markdown: str, markdown_sha256: str, size_bytes: int}
]
page_count: int
total_bytes: int
created_at: datetime
```

Indexes:
- unique `(competition_id, content_hash)`
- `(competition_id, created_at DESC)`

Không có revision counter: `content_hash` + `_id` + `created_at` đã đủ làm identity/audit, và bỏ counter thì không có race giữa hai lần chụp đồng thời.

Canonical hash: serialize UTF-8 JSON với key/order cố định và compact separators, gồm `content_id`, title, slug, order, visibility, Markdown SHA-256 và Markdown text của **từng** page theo `(order, _id)`. **Không** chứa timestamp - nếu chứa thì mỗi lần chụp lại là một revision mới và unique index mất hết tác dụng. Metadata hoặc bytes đổi ⇒ hash mới; nội dung giống hệt ⇒ tái sử dụng revision cũ.

Capture (tối đa 3 vòng) - chạy ngay trong request nộp bài, có trần thời gian:
1. Đọc metadata content đã sắp thứ tự (snapshot A).
2. Bỏ qua page có `size_bytes is None` (chưa có Markdown), giữ danh sách excluded để tab cài đặt giải thích.
3. Đọc bytes thật qua shared storage helper, kiểm UTF-8, tính SHA-256.
4. Metadata nói có file nhưng file thiếu/không đọc được/không phải UTF-8 ⇒ **fail cả snapshot**, không bỏ qua im lặng.
5. Đọc lại metadata (snapshot B); A ≠ B ⇒ retry từ đầu. Quá 3 lần ⇒ `CONTENT_CHANGED_DURING_CAPTURE`.
6. Không page nào đọc được ⇒ `CONTENT_EMPTY`. Vượt `AI_REVIEW_MAX_SNAPSHOT_BYTES` (mặc định 8 MiB, luôn dưới trần 16 MiB của Mongo) ⇒ `CONTENT_SNAPSHOT_TOO_LARGE`; **không** cắt bớt bản authoritative.
7. Upsert theo `(competition_id, content_hash)`; `DuplicateKeyError` được coi là cache hit.

"Nội dung đã publish" ở đây là **mọi content record có Markdown đọc được**, bất kể `visibility`; không thêm lifecycle page mới và không hard-code slug.

### 11.3 `ai_review_jobs` - hàng đợi bền

```text
_id: ObjectId
submission_id: ObjectId               unique - một job cho mỗi bài nộp
competition_id, account_id: ObjectId
status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED"
generation: int                       tăng khi admin chạy lại
run_id: str
attempts: int
max_attempts: int                     ĐÓNG BĂNG lúc enqueue từ settings của API
run_after: datetime                   backoff
claimed_by: str | null                worker id
lease_token: str | null
lease_expires_at, heartbeat_at: datetime | null
bypass_cache: bool
source: "AUTO" | "MANUAL"
requested_by: ObjectId | null
requested_at, created_at, updated_at, started_at, completed_at: datetime
latest_review_id: ObjectId | null
last_error: {code, retryable, occurred_at} | null
projection_applied: bool
```

Indexes:
- unique `submission_id`
- `(status, run_after)` - vòng quét job đến hạn
- `(status, lease_expires_at)` - thu hồi job hết lease

Một row cho mỗi bài, **reset theo `generation`** khi admin chạy lại, thay vì sinh thêm queue row; lịch sử nằm trong `ai_reviews`. `max_attempts` đóng băng lúc enqueue để đổi env giữa chừng không làm job đang chạy đổi luật chơi. `projection_applied` là cờ idempotent cho bước ghi projection về submission: worker chết sau khi ghi review nhưng trước khi ghi projection thì lần chạy lại vẫn áp được projection đúng.

Claim nguyên tử bằng `find_one_and_update` trên điều kiện `status=QUEUED AND run_after<=now`, ghi `lease_token`/`claimed_by`/`lease_expires_at`. **Mọi** lần ghi về sau đều kiểm lại `lease_token` + `generation` + `run_id`, nên một worker bị treo rồi tỉnh dậy không thể ghi đè kết quả của lượt mới hơn. Lỗi tạm thời ⇒ requeue với backoff mũ có jitter (`run_after`).

### 11.4 `ai_reviews` - audit append-only

Một terminal record cho mỗi `(submission_id, generation)`.

```text
_id, run_id, submission_id, competition_id, account_id, generation
submission_no: int | null
status: "COMPLETED" | "FAILED"
verdict: "CLEAR" | "FLAGGED" | "INCONCLUSIVE" | "ERROR"
model_verdict: "CLEAR" | "FLAGGED" | "INCONCLUSIVE" | null   kết luận thô trước hậu kiểm
summary: str
participant_summary: str               gợi ý ngắn cho thí sinh, admin-only (ADR-040); "" khi model không đưa
findings: [
  {source_content_title, source_content_slug, rule_text,
   checkability: "CHECKABLE_FROM_NOTEBOOK" | "NOT_CHECKABLE_FROM_NOTEBOOK",
   status: "VIOLATION" | "COMPLIANT",
   reason,
   evidence: [{cell, start_line, end_line, snippet}]}
]
notebook_sha256: str                   luôn bằng SHA-256 của bytes gốc đã gửi model
notebook_normalized_sha256: str        SHA-256 của bản đã chuẩn hoá
notebook_stats: {cells, code_cells, markdown_cells, lines, truncated, omitted_cells}
content_revision_id, content_hash
provider: "openai_compatible"
provider_host, model
prompt_version, normalization_version, context_policy_version
cache_key
source: "PROVIDER" | "CACHE" | "PIPELINE"
reused_from_review_id: ObjectId | null
bypass_cache, manual: bool
attempts: int
downgrade_codes: [str]
findings_omitted: int
error: {code, message} | null          message đã che
usage: {prompt_tokens, completion_tokens, total_tokens} | null
started_at, completed_at, duration_ms, created_at, updated_at
```

Indexes:
- unique `(submission_id, generation)` - chốt chống sinh hai audit row cho cùng một lượt, kể cả khi reconciler và worker cùng ghi
- `(competition_id, cache_key, status)` - tra cache (chỉ đọc row `COMPLETED` nên index phủ luôn hai field lọc)
- `(submission_id, created_at DESC)` - lịch sử của một bài

`run_id` được lưu và là khoá nghiệp vụ để đối chiếu với job, nhưng ràng buộc duy nhất nằm ở `(submission_id, generation)` - đó mới là thứ phân biệt hai lượt chạy của cùng một bài.

**Không lưu**: API key, full Base URL (chỉ host), raw prompt, raw notebook/policy payload, raw provider response. `error.message` chỉ chứa thông điệp đã che; khi parse output model thất bại, message của Pydantic có thể chứa nguyên văn output nên log chỉ ghi `type(exc).__name__`.

`verdict` chỉ được **hạ cấp** so với `model_verdict` và không bao giờ được nâng: thiếu vi phạm đã kiểm chứng ⇒ FLAGGED thành INCONCLUSIVE; bằng chứng trỏ sai cell/dòng ⇒ bị loại và mã lý do vào `downgrade_codes`. `snippet` của model bị **vứt bỏ** và dựng lại từ chính notebook đã lưu. `ERROR` là verdict do pipeline sinh, model không bao giờ được trả nó.

Cache key = `SHA256(notebook_sha256 + content_hash + provider + host + model + prompt_version + normalization_version + context_policy_version)`, tra trong **cùng cuộc thi**. Chỉ `CACHEABLE_VERDICTS` (CLEAR/FLAGGED/INCONCLUSIVE) được tái sử dụng - **ERROR không bao giờ được cache**. Cache hit vẫn sinh audit row mới với `source=CACHE` và `reused_from_review_id` trỏ về lượt gốc, nên lịch sử không bị nối tắt. Chạy tay luôn `bypass_cache=true`.
