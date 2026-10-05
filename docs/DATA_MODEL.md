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
- `active`: bool - khóa toàn nền tảng (disable hủy hiệu lực mọi session). Tài khoản tự đăng ký chờ duyệt cũng mang `active: false` (ADR-049) - hai trạng thái phân biệt được nhờ marker `pending_approval`.
- `pending_approval`: bool (chỉ ghi khi `true`) - marker tài khoản tự đăng ký đang chờ admin duyệt (ADR-049). **Vắng mặt = đã duyệt** - đúng cho mọi tài khoản cũ và tài khoản do admin tạo, nên không có backfill. Duyệt = một update nguyên tử `$set active:true, updated_at` + `$unset pending_approval`; `PATCH {active}` bị chặn khi marker còn (điều kiện update loại pending), và `resolve_session`/login kiểm marker như phòng thủ hai lớp kể cả khi `active` bị bật nhầm. Không bao giờ lộ ra ngoài dưới dạng field thô - API chỉ trả `pending: bool` qua `public_account()`.
- `slug` (str | absent ở account cũ) - dùng làm segment đường dẫn artifact trên MinIO (ADR-033). Sinh tự động từ `name` ở **lần nộp bài đầu tiên**, không nhập tay, không bao giờ sinh lại (đổi `name` không đổi slug). Trùng thì thêm `-` + 3 ký tự random. Không có trong representation nào trả về API.
- `pinned_competition_ids` (array[ObjectId] | absent ở account cũ) - ghim cuộc thi theo tài khoản (ADR-057). Sở thích riêng của người dùng, **không** phải membership và không cấp quyền gì; account thiếu field được `$addToSet`/`$pull` coi như mảng rỗng nên không cần migration. Chỉ ghi qua `PUT`/`DELETE /api/competitions/{slug}/pin` bằng toán tử nguyên tử trên một document (không đọc-rồi-`$set`); **không bao giờ** lộ qua `public_account()` hay endpoint admin. Id ghim của cuộc thi đã xoá nằm lại vô hại - không hiển thị, và ObjectId mới không kế thừa ghim cũ.
- `created_at`, `updated_at` (UTC, timezone-aware)

Indexes:
- unique trên `email` - tạo idempotent ở app startup (`ensure_indexes`); cũng là chốt chặn hai lượt đăng ký tranh nhau (ADR-049, `DuplicateKeyError` → cùng response 202)
- unique **sparse** trên `slug` - sparse để account cũ chưa có field này không cùng rơi vào giá trị null và chặn nhau (ADR-033)
- Không thêm index cho `pending_approval`: collection nhỏ, và cả `pending_only` lẫn `stats.pending` đều là đường quản trị chạy không thường xuyên - quét collection rẻ hơn chi phí ghi thêm index.

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
- `primary_metric`: `f1` | `precision` | `recall` - **chỉ cuộc thi v1 đọc field này**; từ ADR-048 chỉ số chính của cuộc thi v2 nằm trong `scoring_config.output_contract.primary_metric`, và mọi đường đọc dùng `contracts.result_contract()` để hai đời ra cùng một hình dạng
- `quota_per_day` (0-1000)
- `leaderboard_visible` (bool)
- `resources` (list, default `[]` | absent ở document cũ) - link Google Drive cho participant tải, xem §9
- `scoring_config` (object | absent) - Sprint 05, hai đời phân biệt bằng field `version` (ADR-048); chỉ chứa CSV/metric behavior, xem §7
- `ground_truth` (object | absent) - Sprint 05; metadata/path private, xem §8
- `created_by` (email của admin tạo) - chỉ trả trong represent admin, không bao giờ lộ cho guest/participant (ADR-016)
- `created_at`, `updated_at` (UTC, timezone-aware)

Indexes:
- unique trên `slug` - tạo idempotent ở app startup (`ensure_indexes`)

Derived field (không lưu DB):
- `submission_count` - **không** là field của document. `GET /api/competitions` chạy một aggregation `$match competition_id` + `$group _id` trên `submissions` cho cả trang rồi gắn vào từng item (ADR-032). Đếm mọi document submission đã persist, không phụ thuộc `status` **lẫn `review`**, nên bài bị reject (không tạo document) không được tính, còn bài đã persist mà admin từ chối thì vẫn tính - nó vẫn là một lượt đã tiêu (ADR-035). Không migration, không index mới: index có prefix `competition_id` của `submissions` (§6) đã phục vụ `$match` này. Detail và endpoint admin không dùng lại field này - admin đã có `submission_count` từ `activity_counts`.
- `my_stats` - **không** là field của document. `GET /api/competitions` gắn vào item **chỉ khi** người gọi là thành viên đang hoạt động: `{rank, rank_total, best_score, used_today}` (ADR-056). `used_today` đếm bài `completed` trong ngày UTC hiện tại, cùng quy ước `quota` (bài bị admin từ chối vẫn tiêu lượt, ADR-035; mốc ngày theo ADR-019) và tính bằng một aggregation `$facet` cho cả trang. `rank`/`rank_total`/`best_score` lấy từ `leaderboard_response(limit=1)` nên giữ nguyên tie-break, chiều metric và lọc metric ẩn (ADR-012); bảng bị ẩn thì không trả hạng/điểm và không đọc bảng. Không migration, không index mới: aggregation lọc theo `(competition_id, account_id)` đã dùng index sẵn có của `submissions` (§6).

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
- `quota_claims` (object | absent ở membership cũ) - dấu `attempt_id → ngày` của những suất đang bị **giữ** bởi một lượt nộp v2 chưa kết thúc (ADR-048): đường v2 giữ suất lâu hơn một request nên `$inc` không đủ để biết suất nào của lượt nào. Hoàn suất xoá **đúng dấu của lượt đó** và chỉ chạy khi cờ `quota_charged` của lượt còn bật, nên gọi lặp không trừ hai lần; lượt v1 và lượt cũ không có dấu nào.

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
- `metrics`: raw float, **tập khoá do hợp đồng kết quả của cuộc thi quyết định** - `{f1, precision, recall}` ở cuộc thi v1, đúng tập khoá bộ chấm Python trả về ở cuộc thi v2 (ADR-048). Đây vốn đã là `dict[str, float]` nên không có migration; UI, sort, leaderboard và Excel đọc cột từ `contracts.result_contract(competition)` chứ không đọc theo tên khoá
- `primary_score` - luôn là `metrics[primary_metric]` của hợp đồng, không tính lại và không đổi thang
- `scoring_ref` (object | absent) - **chỉ có ở bài chấm bằng bộ chấm v2** (ADR-048), ghim lại đúng thứ đã sinh ra điểm để hậu kiểm: `{version: 2, revision, config_fingerprint, source_sha256, ground_truth_sha256, submission_sha256, runtime_id}`. Bài v1 và bài legacy không có field này; không chứa source, ground truth hay đường dẫn
- `created_at`
- `review` (object | absent ở record cũ) - quyết định xét duyệt **hậu kiểm** của admin, là trục **độc lập** với `status` (ADR-035):
  - `status`: `rejected` | `accepted`
  - `note` (str | null) - lý do từ chối, participant đọc được; luôn `null` khi `accepted`
  - `reviewed_by` (ObjectId → accounts._id), `reviewed_at` (UTC, timezone-aware)
  - Ghi **cả object** trong một `$set` trên một document nên không bao giờ trộn metadata của hai lần xét duyệt; chỉ giữ quyết định **gần nhất**, không có event history. `reviewed_by`/`reviewed_at` không bao giờ đi ra endpoint participant.
- `content_snapshot` (object | absent) - bản thể lệ và tài nguyên **bất biến** đã chốt tại thời điểm nộp, chỉ có khi AI bật lúc submit (ADR-036): `{state: "CAPTURED" | "ERROR", revision_id, content_hash, error_code, captured_at}`. `ERROR` ghi lại sự thật là không chụp được (`CONTENT_EMPTY` | `CONTENT_SNAPSHOT_TOO_LARGE` | `CONTENT_CHANGED_DURING_CAPTURE` | `CONTENT_UNREADABLE`) chứ **không** chặn lượt nộp; bài không chụp được thì không chạy lại AI được và admin thấy banner giải thích.
- `ai_review` (object | absent) - trục trạng thái AI, **độc lập** với `status` và `review` (ADR-036): `{state: "QUEUED" | "RUNNING" | "COMPLETED" | "ERROR", verdict: "CLEAR" | "FLAGGED" | "INCONCLUSIVE" | "ERROR" | null, summary, participant_summary, generation, run_id, latest_review_id, source_warning_count, requested_at, updated_at}`. Chỉ có khi `auto_review=true` hoặc admin đã chạy tay; `auto_review=false` vẫn chụp revision nhưng **không** tạo projection/job. Snapshot lỗi + auto ⇒ `state/verdict="ERROR"` với `run_id` cố định để reconciler bảo đảm có audit row, và **không** tạo job gọi provider. Không có field nào ở đây ảnh hưởng `metrics`, `primary_score`, `status` hay tư cách xếp hạng.
  - `source_warning_count` (int | null, ADR-055) - số dấu hiệu nguồn dataset cần BTC xem lại từ lượt hiện tại; chỉ admin đọc, `null` trong lúc chờ/chạy lại; không thay verdict.
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

`my_submission_count` trên danh sách cuộc thi cũng là **derived**, không lưu DB và không thêm index (ADR-057): số document của `(account_id, competition_id)` **không lọc** `status`/`review` - cùng định nghĩa với `total` trong `GET /submissions/me` và `submission_count` toàn hệ thống (ADR-032), tính bằng một nhánh `$facet` chung với `used_today` cho cả trang. Đây **không phải** số bài được tính kết quả của bảng xếp hạng (ADR-035) - hai con số khác nhau khi có bài bị từ chối hoặc record `failed` cũ, nên UI gọi nó là "Tổng bài đã nộp".

## 6b. scoring_attempts - implemented (ADR-048, hàng đợi chấm v2)

Một document cho **mỗi lần thí sinh nhấn Nút** ở cuộc thi v2, sống từ lúc API nhận request tới khi có
kết quả hoặc bị đóng. Bài chưa chấm **không** nằm ở §6 vì `submissions.status` chỉ có `completed` và
mọi đường đọc (quota, leaderboard, AI review) đều dựa vào nó; khi chấm xong, `_id` của lượt **chính
là** `_id` của submission được ghi, nên không có bản ghi thứ hai phải đồng bộ.

Fields:
- `_id` (= `attempt_id` trả cho client, và = `submissions._id` của lượt thành công)
- `competition_id`, `account_id`, `membership_id`
- `idempotency_key` (str, ≤128 ký tự) + `payload_sha256` - một key cho **một lần nhấn Nút**: cùng key
  cùng bytes = trả lại lượt cũ (không tiêu thêm quota), cùng key khác bytes = 409
- `status`: `STAGING` (đang nhận file) → `QUEUED` → `RUNNING` → `COMPLETED` | `FAILED` | `EXPIRED`, và
  `RESOLVING` khi lần ghi kết quả dở dang và worker đang đối soát. `RESOLVING` **không** phải `FAILED`:
  chỉ kết luận hỏng khi đã chứng minh không có submission
- `queue_slot` (int, chỉ khi đang giữ chỗ) - chỗ trong dải `0..SCORING_QUEUE_CAPACITY-1`. Trần hàng đợi
  là **ràng buộc của unique index trên field này**, không phải một phép đếm-rồi-insert, và index
  **không** gắn với cuộc thi: trần là của cả hệ thống
- `staging_prefix` - prefix MinIO tạm (`competitions/<slug>/staging/scoring/<attempt_id>/`), xoá khi
  lượt đóng; kho tạm chỉ giữ bài đang chờ hoặc đang chấm
- `deadline_at` - mốc 60 giây tính từ lúc API nhận request (trước khi parse multipart), gồm upload, chờ,
  chấm và ghi kết quả; quá mốc này là `EXPIRED`
- `claimed_by` / `lease_token` / `lease_expires_at` - worker nào đang chấm và tới khi nào; `lease_token`
  có mặt trong mọi filter ghi nên worker mất lease không ghi đè được document của người khác
- `quota_charged` (bool) - lượt này đã tiêu một suất quota chưa; hoàn suất chỉ chạy khi cờ còn bật nên
  retry, restart và đối soát không hoàn hai lần
- `submission_no` (int | null) - số thứ tự cấp trước khi ghi bài, dùng lại counter của membership (§4)
- `result` (object | null) - kết quả bộ chấm (metrics + `scoring_ref`) ghi **trước** khi tạo submission,
  để một lượt ghi dở vẫn đối soát được thay vì phải chấm lại
- `artifacts` (object) - hai artifact đã nhận của lượt (cùng shape với §6)
- `error` (`{code,message}` | null) - lý do lượt không thành công
- `created_at` / `updated_at`

Indexes:
- unique `(competition_id, account_id, idempotency_key)` (`attempt_idempotency_unique`) - một lần nhấn Nút là một lượt
- unique partial `queue_slot` (`attempt_queue_slot_unique`, chỉ document đang giữ chỗ) - trần hàng đợi
- `(competition_id, account_id, created_at DESC, _id DESC)` - danh sách lượt chưa kết thúc của thí sinh
- `(status, deadline_at)` - vòng đối soát tìm lượt quá hạn
- `(status, lease_expires_at)` - vòng đối soát thu hồi lượt của worker đã chết

## 7. Scoring config (embedded trong competitions)

`competitions.scoring_config` có **hai đời**, phân biệt bằng field `version` (ADR-048). Document v1 không có `version` và được đọc nguyên trạng - **không migrate**.

**v1** (Sprint 05, bộ chấm sklearn cố định):
- `id_column`, `prediction_column`, `label_column`
- `average`: `binary` | `macro` | `weighted`
- `pos_label` (nếu binary)
- `higher_is_better`: `true` (MVP)

**v2** (ADR-048, bộ chấm Python do admin cấp):
- `version`: `2`
- `revision` (int, bắt đầu `1` ở lần lưu đầu; `0` = chưa từng lưu) - điều kiện ghi lạc hậu, xem dưới
- `input_schema`: `{ground_truth, submission, id_matching: "exact", row_alignment: "ground_truth_order", preprocessing_version: 1}`, mỗi file là `{id_column, allow_extra_columns, columns: [{name, type: "string"|"integer"|"number", nullable, allowed_values: [...]|null}]}`
- `evaluator`: `{name, entrypoint: "evaluate", source_path, source_sha256, runtime_id}` - **metadata**; source nằm ở file riêng tư (§7b), không nằm trong document
- `output_contract`: `{metrics: [{key, label, decimals}], primary_metric, higher_is_better}` hoặc `null` khi còn là bản nháp
- `verification`: bằng chứng lượt chạy thử - `{state: "passed", execution_fingerprint, config_fingerprint, observed_keys, tested_submission_sha256, tested_at, tested_by}` hoặc `null`. Hiệu lực so theo `execution_fingerprint` + `observed_keys`; `config_fingerprint` chỉ là dấu vết của đúng cấu hình lúc chạy thử

Không lưu `scoring_config.json`. `quota_per_day` dùng top-level competition field. `MAX_UPLOAD_MB` chỉ đến từ environment, không lưu Mongo (ADR-011).

Hai bất biến của v2: (a) **ghi là `$set` nguyên khối kèm điều kiện `scoring_config.revision`** - Mongo standalone không có transaction nên revision là toàn bộ cơ chế chống ghi đè, và upload ground truth cũng tăng revision vì ground truth nằm trong dấu vân tay; (b) **`verification` không bao giờ được tin theo tuổi** - nó chỉ còn hiệu lực khi `execution_fingerprint` (protocol + `preprocessing_version` + schema + sha256 source + sha256 ground truth + runtime) khớp cấu hình đang lưu **và** `observed_keys` của lượt đã chạy đúng bằng tập khoá hợp đồng đang khai (chưa khai hợp đồng thì chỉ cần phần đã chạy; `config_fingerprint` là dấu vết, không phải điều kiện - nới hẹp 2026-10-01). Đổi source, đổi đáp án, đổi schema, khai lệch tập khoá, hay chạy thử lại trên một runtime khác đều làm lượt chạy thử cũ hết giá trị mà không phải xoá field nào; đổi tên hiển thị, số thập phân, ẩn/hiện, metric chính hay chiều xếp hạng thì **không** - lượt chạy thử không quan sát được chúng.

## 7b. File riêng tư của bộ chấm (filesystem, không có collection)

Dưới `<DATA_DIR>/competitions/<competition_id>/private/`:
- `ground-truth-<sha256[:16]>.csv` (v2) hoặc `ground_truth.csv` (v1, layout cũ giữ nguyên)
- `evaluator/<sha256>.py` - source bộ chấm v2

Tên gắn hash nội dung và ghi theo kiểu "ghi nếu chưa có", nên một lượt chấm đang chạy vẫn đọc đúng bản đã được xác minh kể cả khi admin vừa lưu bản mới. Không có route public nào phục vụ hai loại file này; `evaluator.source_path` và `ground_truth.path` là đường dẫn **tương đối** trong `DATA_DIR` và không bao giờ đi ra API (ADR-048).

## 8. Ground truth metadata (embedded trong competitions)

`competitions.ground_truth`:
- `path`: relative trong `DATA_DIR` - `competitions/<competition_id>/private/ground_truth-<sha256[:16]>.csv` (v2) hoặc `.../ground_truth.csv` (v1)
- `row_count`
- `columns`: danh sách header, không chứa row/label values. Ở v2 lấy từ **schema admin khai** (không phải header đọc được của file), nên nó luôn khớp cấu hình đang áp dụng
- `sha256` (v2; v1 ghim thêm ở lượt chạy thử đầu tiên) - đầu vào của dấu vân tay thực thi; readiness còn đối chiếu hash này với bytes trên đĩa nên sửa file ngoài luồng làm cuộc thi hết sẵn sàng
- `uploaded_at` (UTC)

File thật private trên persistent disk. Scoring ready khi có `scoring_config`, metadata path hợp lệ và file thường tồn tại (không chấp nhận symlink). Config/ground truth khóa khi competition closed hoặc có submission completed.

Readiness dùng cho publish là **một** hàm dùng chung (`backend/app/scoring/readiness.py`) đọc và parse lại ground truth thật, không chỉ kiểm tra file tồn tại (ADR-017).

## 9. Competition resources (embedded trong competitions)

`competitions.resources`: list `{label, url}`, tối đa 10 phần tử, label ≤120 ký tự, url ≤2048 ký tự và phải là `https` trên `drive.google.com`/`docs.google.com` (không credentials). Đây là link ngoài, không phải file trên hệ thống - không có collection, không có thư mục trong `<DATA_DIR>` (ADR-015).

Document tạo trước thay đổi này không có field; serializer trả `[]` nên không cần migration Mongo. `clone` copy nguyên list.

## 10. Deletion semantics (ADR-018)

Không dùng Mongo transaction (standalone). Thứ tự xoá luôn là con trước – cha sau để lỗi giữa đường vẫn còn bản ghi gốc cho lần gọi lại:

- `DELETE /api/admin/competitions/{id}` (`draft` + `closed`; `published` → 409 `COMPETITION_NOT_DELETABLE`): `ai_review_jobs` → `ai_reviews` → `submissions` → `scoring_attempts` → `competition_memberships` → `competition_contents` → `competition_content_revisions` → `competitions` (ADR-036 chèn ba collection AI vào đúng vị trí tham chiếu của chúng: job và audit row đứng trước `submissions` vì cùng trỏ vào nó, revision đứng sau vì bị `submissions`/`ai_reviews` tham chiếu; `scoring_attempts` đứng ngay sau `submissions` để worker không còn gì để claim - ADR-048), sau đó best-effort `rmtree` hai root `<DATA_DIR>/competitions/<id>` và `<DATA_DIR>/submissions/<id>` **và** dọn hai prefix MinIO `competitions/<slug>/` + `competitions/<id>/` (ADR-028, ADR-033; kho tạm của lượt chờ chấm nằm dưới prefix `competitions/<slug>/staging/scoring/` nên cũng được dọn theo). Một bước dọn lỗi ⇒ `files_removed:false`, DB đã xoá xong. `accounts` và `sessions` không bị đụng.
- Xoá member (dòng dưới) và xoá account (ADR-047) **không** xoá `scoring_attempts`: lượt đang chờ/chấm của account đó do worker đóng khi revalidate (membership biến mất hoặc không còn `active`), và suất quota của lượt đó không còn chỗ để hoàn vì bộ đếm nằm trên membership đã xoá - vô hại, không rò sang account khác.
- `DELETE /api/admin/competitions/{id}/members/{account_id}`: xoá record submission chưa `completed` của account (kèm object MinIO/file legacy, best-effort) rồi xoá membership cuối cùng. Bài `completed` không bao giờ bị xoá - vướng thì trả 409 và dừng.
- `DELETE /api/admin/accounts/{id}?confirm_email=<email>` (ADR-047): `ai_review_jobs` → `ai_reviews` → `submissions` **chỉ bài chưa `completed`** (kèm file legacy và object MinIO, best-effort) → `competition_memberships` → `sessions` → `accounts`. `sessions` **bắt buộc** nằm trong cascade: bỏ sót thì token phiên cũ vẫn đăng nhập được vào một tài khoản đã xoá. Bài `completed` không bao giờ bị xoá - vướng thì 409 `ACCOUNT_HAS_SUBMISSIONS`; tài khoản đang là vết hậu kiểm (`review.reviewed_by`, `ai_review_config.updated_by`) cũng bị 409 `ACCOUNT_REFERENCED`. `competitions`, `competition_contents` và `competition_content_revisions` **không** bị đụng - lịch sử thi của đội khác không thuộc về account này.
- `POST /api/competitions/{slug}/leave`: chỉ `update` `active=false`, không xoá gì.

Hai đường xoá submission ở trên dùng chung một hiện thực `submissions.service.delete_submissions_matching(db, query)` - khác nhau chỉ ở bộ lọc (theo cuộc thi, hay theo toàn bộ account), nên luật dọn file/artifact chỉ có một chỗ để sửa.

Xoá competition `published` không có trong phạm vi: cuộc thi đang chạy phải Kết thúc trước. `draft` và `closed` xoá được (cascade), nên "đã kết thúc" không phải là bảo đảm còn dữ liệu - muốn giữ lịch sử thi thì đừng xoá (ADR-027).

## 10b. Clone cuộc thi - bản sao độc lập (ADR-050)

`POST /api/admin/competitions/{id}/clone` tạo một document `competitions` **mới** (luôn `draft`) cùng các document `competition_contents` mới. Mọi file của bản sao nằm dưới thư mục riêng `competitions/<clone_id>/` (`content/`, `assets/`, `private/`); **không** document hay file nào được chia sẻ với nguồn.

Được copy:
- Config cấp cuộc thi: `join_mode`, `primary_metric`, `quota_per_day`, `leaderboard_visible`, `resources`; `name` = `"<tên nguồn> (bản sao)"`, `slug` mới `<slug>-copy`, `start_at`/`end_at` mới (now → +1 năm), `created_by` = admin thực hiện. Slug hết 5 ứng viên → 409 `SLUG_EXISTS`.
- `competition_contents`: title/slug/order/visibility giữ nguyên; `_id`, `markdown_path` và file là của bản sao. Markdown chỉ copy khi nguồn có `size_bytes`; ghi atomic rồi cập nhật `size_bytes`; trang chưa upload giữ `size_bytes: null`.
- Assets: giữ nguyên tên `uuid4.<ext>` (để link tương đối `assets/...` trong Markdown vẫn trỏ đúng), đọc và kiểm signature như endpoint list trước khi ghi vào `assets/` của bản sao.
- `scoring_config`: v1 copy nguyên cấu hình cột cố định; v2 copy `input_schema`/`evaluator`/`output_contract` nhưng `revision = 0`, `evaluator.runtime_id = null`, `verification = null`; source bộ chấm ghi lại dưới `private/evaluator/<sha256>.py` của bản sao.
- `ground_truth` + file: v1 ghi `private/ground_truth.csv`; v2 ghi `private/ground-truth-<sha256[:16]>.csv`; `path` trỏ về bản sao, `sha256`/`row_count`/`columns` giữ nguyên sau khi đối chiếu với file thật và schema.
- `ai_review_config`: các field hỗ trợ (`enabled`, `auto_review`, `participant_visible`, `provider`, `base_url`, `model`) và `api_key_ciphertext` copy **nguyên bytes** - cùng deployment nên cùng khoá Fernet, không decrypt→re-encrypt; `updated_by`/`updated_at` mới; `verified_at`/`verified_fingerprint`/`transfer_acknowledgement` **không** copy.

Không copy: `status`, `join_code_hash`, ngày thi gốc, memberships, submissions, `scoring_attempts`, `ai_review_jobs`/`ai_reviews`, `competition_content_revisions`, bằng chứng chạy thử scoring và dấu xác minh kết nối AI.

Hệ quả và giới hạn:
- Bản sao **độc lập**: sửa/xoá nguồn không đổi bản sao (file riêng), và xoá bản sao không đụng nguồn.
- Preflight đọc và kiểm toàn bộ nguồn **trước mọi lượt ghi**: Markdown mất dù metadata nói có, size/hash lệch, asset sai định dạng, source bộ chấm lệch hash, CSV ground truth không hợp schema, ciphertext không giải mã được, endpoint vi phạm network policy → 409 `CLONE_SOURCE_INVALID`, **không** document/file nào được tạo. Phần nguồn chưa cấu hình thì bản sao cũng trống phần đó; bản sao dùng đúng bytes đã chụp, không đọc lại file nguồn sau insert.
- Lỗi ghi sau insert → xoá content/competition/thư mục của **chính bản sao** rồi trả 500 `CLONE_WRITE_FAILED`; lỗi ở bước dọn chỉ được log.
- Mongo standalone **không có transaction**: rollback chỉ chạy khi process còn sống. Process bị kill giữa lúc ghi có thể để lại bản sao dở dang (content thiếu file, hoặc document đã tạo nhưng chưa có scoring/AI config) và **không** tự dọn; log ghi `clone=<id>` làm manh mối để người vận hành xoá tay. Không có bảo đảm atomicity tuyệt đối.

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
- Clone (ADR-050) copy nguyên ciphertext + các field hỗ trợ nhưng **không** copy `verified_at`/`verified_fingerprint` (vết xác minh thuộc cuộc thi nguồn) và `updated_by`/`updated_at` là của admin clone.
- Import (`POST .../ai-review/import`, ADR-050) ghi **cả object** bằng một `$set` (khác dotted `$set` của PUT) nên key cũ của đích bị xoá nếu nguồn không có key, và hai field xác minh của đích bị xoá theo snapshot; key vẫn chỉ tồn tại dạng ciphertext, không bao giờ rời server dưới dạng plaintext.

### 11.2 `competition_content_revisions` - bản thể lệ bất biến

```text
_id: ObjectId
competition_id: ObjectId
content_hash: str                     SHA-256 hex của canonical payload
pages: [
  {content_id, title, slug, order, visibility: "public"|"members",
   markdown: str, markdown_sha256: str, size_bytes: int}
]
resources: [{label: str, url: str}]      link Google Drive BTC cấp tại thời điểm nộp (ADR-055)
page_count: int
total_bytes: int
created_at: datetime
```

Indexes:
- unique `(competition_id, content_hash)`
- `(competition_id, created_at DESC)`

Không có revision counter: `content_hash` + `_id` + `created_at` đã đủ làm identity/audit, và bỏ counter thì không có race giữa hai lần chụp đồng thời.

Canonical hash: serialize UTF-8 JSON với key/order cố định và compact separators, gồm `content_id`, title, slug, order, visibility, Markdown SHA-256 và Markdown text của **từng** page theo `(order, _id)`. **Không** chứa timestamp - nếu chứa thì mỗi lần chụp lại là một revision mới và unique index mất hết tác dụng. Metadata, bytes hoặc `resources` đổi ⇒ hash mới; nội dung giống hệt ⇒ tái sử dụng revision cũ. Revision trước ADR-055 thiếu `resources` được hiểu là `[]` khi AI chạy lại.

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
last_error: {code, message, occurred_at, phase?} | null   phase chỉ có khi httpx timeout; connect/read/write/pool/timeout
projection_applied: bool
```

Indexes:
- unique `submission_id`
- `(status, run_after)` - vòng quét job đến hạn
- `(status, lease_expires_at)` - thu hồi job hết lease

Một row cho mỗi bài, **reset theo `generation`** khi admin chạy lại, thay vì sinh thêm queue row; lịch sử nằm trong `ai_reviews`. `max_attempts` đóng băng lúc enqueue để đổi env giữa chừng không làm job đang chạy đổi luật chơi. `projection_applied` là cờ idempotent cho bước ghi projection về submission: worker chết sau khi ghi review nhưng trước khi ghi projection thì lần chạy lại vẫn áp được projection đúng.

Claim nguyên tử bằng `find_one_and_update` trên điều kiện `status=QUEUED AND run_after<=now`, ghi `lease_token`/`claimed_by`/`lease_expires_at`. **Mọi** lần ghi về sau đều kiểm lại `lease_token` + `generation` + `run_id`, nên một worker bị treo rồi tỉnh dậy không thể ghi đè kết quả của lượt mới hơn. Lỗi tạm thời ⇒ requeue với backoff mũ có jitter (`run_after`).

`completed_at` là mốc chốt job: với lượt thành công nó bằng `completed_at` của audit row (`created_at + duration_ms` của lượt gọi provider); với lỗi timeout từ worker đang chạy, nó bằng mốc phát hiện lỗi, không phải lúc job được claim. `run_after` của retry được cộng backoff vào **mốc phát hiện lỗi**, không cộng vào mốc bắt đầu attempt. Mốc lỗi được suy ra từ mốc vào attempt cộng thời gian đã trôi đo bằng đồng hồ monotonic (kể cả khi `now` được truyền từ test). Dòng `last_error.phase` chỉ phân loại ngoại lệ HTTP (connect/read/write/pool, hoặc timeout khi không rõ subtype), không kết luận nguyên nhân của gateway/provider.

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
  {source_content_title, source_content_slug, rule_text,   backend điền từ revision; "" khi unresolved
   rule_ref: str | null          ref đã resolve (ADR-045)
   model_rule_ref: str           ref model gửi, giữ nguyên để đối chiếu
   rule_resolution: "REFERENCE" | "CANONICAL_QUOTE" | "UNRESOLVED"
   rule_verified: bool
   evidence_count: int           số khoảng model khai
   valid_evidence_count: int     số khoảng còn dùng được sau khi kiểm
   evidence_verified: bool       có >= 1 khoảng hợp lệ
   verified: bool                rule_verified AND evidence_verified
   traceable: bool               verified AND VIOLATION AND CHECKABLE
   verification_codes: [str]     chẩn đoán riêng của finding
   checkability: "CHECKABLE_FROM_NOTEBOOK" | "NOT_CHECKABLE_FROM_NOTEBOOK",
   status: "VIOLATION" | "COMPLIANT" | "UNCLEAR",
   reason,
   evidence: [{cell, start_line, end_line, snippet}]}
]
source_signals: [{cell, start_line, end_line, snippet, reason,
                  match: "MATCHED_RESOURCE" | "FOLDER_MEMBERSHIP_UNVERIFIED" | "EXTERNAL_SOURCE" | "UNVERIFIED_SOURCE",
                  urls: [{url, match, resource_label}], warning: bool}]   ADR-055; admin-only
resources_configured: int               số link trong revision dùng đối chiếu
notebook_sha256: str                   luôn bằng SHA-256 của bytes gốc đã gửi model
notebook_normalized_sha256: str        SHA-256 của bản đã chuẩn hoá
notebook_stats: {cells, code_cells, markdown_cells, lines, truncated, omitted_cells}
content_revision_id, content_hash
provider: "openai_compatible"
provider_host, model
prompt_version, normalization_version, context_policy_version
canonicalization_version, rule_ref_version, verifier_version   ADR-045; row cũ thiếu ⇒ đọc ra null
source_signal_version: str             ADR-055; row cũ thiếu ⇒ đọc ra null
cache_key
source: "PROVIDER" | "CACHE" | "PIPELINE"
reused_from_review_id: ObjectId | null
bypass_cache, manual: bool
attempts: int
downgrade_codes: [str]                mã ở mức lượt, giữ để tương thích
error: {code, message, occurred_at, phase?} | null   message đã che; phase chỉ khi httpx timeout
usage: {prompt_tokens, completion_tokens, total_tokens} | null
started_at, completed_at, duration_ms: int | null, created_at, updated_at
```

Indexes:
- unique `(submission_id, generation)` - chốt chống sinh hai audit row cho cùng một lượt, kể cả khi reconciler và worker cùng ghi
- `(competition_id, cache_key, status)` - tra cache (chỉ đọc row `COMPLETED` nên index phủ luôn hai field lọc)
- `(submission_id, created_at DESC)` - lịch sử của một bài

`run_id` được lưu và là khoá nghiệp vụ để đối chiếu với job, nhưng ràng buộc duy nhất nằm ở `(submission_id, generation)` - đó mới là thứ phân biệt hai lượt chạy của cùng một bài.

Ba mốc thời gian của một lượt thành công: `created_at` là lúc worker bắt đầu xử lý job, `duration_ms` là độ trễ **đo được** của riêng lượt gọi provider, và `completed_at` = `created_at + duration_ms`, tức lúc lượt gọi kết thúc. Job tương ứng trong `ai_review_jobs` chốt ở đúng `completed_at` đó. Vì vậy đọc `completed_at` là đã có mốc kết thúc - **không** cộng thêm `duration_ms` lần nữa. Lượt đọc cache (`source=CACHE`) có `duration_ms=0` vì không gọi provider. Lượt lỗi khi đọc notebook hoặc sau khi đã gọi provider: `created_at` là lúc vào attempt cuối, `completed_at`/`error.occurred_at` là mốc phát hiện lỗi, `duration_ms` đo **toàn bộ attempt cuối** bằng đồng hồ monotonic (bao gồm chuẩn bị notebook, gọi provider và kiểm output nếu đã tới các bước đó), không phải thời lượng HTTP call riêng được ghi trong log provider; `updated_at` là mốc lỗi. `started_at` vẫn có thể là mốc claim job từ queue, và `attempts` thể hiện tổng số lượt thử. Lượt lỗi được kết thúc trước nhánh đọc notebook hoặc lỗi lease được reconciler xử lý, để `duration_ms=null` thay vì giả định 0; khi chưa biết mốc khác thì `created_at=completed_at`. Row cũ `duration_ms=0` và thiếu `model`/`phase` vẫn đọc được, **không backfill** vì không thể khôi phục chính xác thời lượng hay subtype. Model/host chỉ được gắn khi đã resolve đích provider; `phase` là loại timeout của httpx, không chứng minh provider đã bắt đầu xử lý hay nguyên nhân chậm.

**Không lưu**: API key, full Base URL (chỉ host), raw prompt, raw notebook/policy payload, raw provider response. `error.message` chỉ chứa thông điệp đã che; khi parse output model thất bại, message của Pydantic có thể chứa nguyên văn output nên log chỉ ghi `type(exc).__name__`.

`verdict` chỉ được **hạ cấp** so với `model_verdict` và không bao giờ được nâng: thiếu vi phạm `traceable` ⇒ FLAGGED thành INCONCLUSIVE; bằng chứng trỏ sai cell/dòng ⇒ bị loại và mã lý do vào `verification_codes` của finding (kèm `downgrade_codes` ở mức lượt để tương thích). `snippet` của model bị **vứt bỏ** và dựng lại từ chính notebook đã lưu. `ERROR` là verdict do pipeline sinh, model không bao giờ được trả nó.

Từ ADR-045, `source_content_title`/`source_content_slug`/`rule_text` của một finding **không** đến từ model nữa: model chỉ trả `rule_ref` (bắt buộc) và `rule_quote` (tuỳ chọn, chỉ là khoá tra cứu, **không bao giờ** được lưu làm văn bản quy định), backend resolve về `RuleBlock` trong revision rồi tự điền lại. `RuleIndex` được **dẫn xuất lúc worker đọc revision**, không lưu vào `competition_content_revisions`, nên `canonical_content_hash` và mọi document revision không đổi - không migration, không backfill. Bằng chứng được kiểm **độc lập** với việc resolve rule: một `rule_ref` sai vẫn giữ được các khoảng dòng hợp lệ và vẫn đếm ra phần bị loại.

Cache key = `SHA256(competition_id + content_hash + notebook_sha256 + provider + host + model + max_notebook_chars + prompt_version + normalization_version + context_policy_version + canonicalization_version + rule_ref_version + verifier_version + source_signal_version)`, tra trong **cùng cuộc thi**. `max_notebook_chars` nằm trong khoá vì nó **cắt bớt** nội dung: hạ trần thì notebook dài mất cell mà hash thô của artifact không đổi. Ba version cuối (ADR-045) không đổi nội dung gửi model nhưng đổi cách dựng marker, cách sinh `rule_ref` và cách hậu kiểm, tức là đổi ý nghĩa của kết quả đã lưu. Chỉ `CACHEABLE_VERDICTS` (CLEAR/FLAGGED/INCONCLUSIVE) được tái sử dụng - **ERROR không bao giờ được cache**. Cache hit vẫn sinh audit row mới với `source=CACHE` và `reused_from_review_id` trỏ về lượt gốc, nên lịch sử không bị nối tắt. Chạy tay luôn `bypass_cache=true`.
