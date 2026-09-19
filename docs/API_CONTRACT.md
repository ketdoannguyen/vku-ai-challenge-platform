# API Contract - AI Challenge Platform

Nguồn sự thật về API. Mỗi endpoint đánh dấu `implemented` (đã có trong code và có test) hoặc `planned` (baseline từ `plans/02_ARCHITECTURE_CONTRACTS.md`, chưa code).

Quy ước chung:
- Toàn bộ route dưới `/api`, same-origin với frontend qua Nginx (ADR-002).
- Auth bằng session cookie (`aic_session`); `GET /api/auth/me` là nguồn frontend biết account hiện tại.
- Unauthorized → HTTP 401; authenticated but forbidden → HTTP 403.
- Error response thống nhất:

```json
{
  "error": {
    "code": "SUBMISSION_SCHEMA_INVALID",
    "message": "File submission thiếu cột prediction."
  }
}
```

## 1. Health

| Method | Path | Status | Mô tả |
|---|---|---|---|
| GET | `/api/health` | implemented | Trả `{"status":"ok","mongo":"reachable"}` + 200 khi Mongo reachable; `{"status":"degraded","mongo":"unreachable"}` + 503 khi không. Không expose thông tin nội bộ. **Cố ý không kiểm tra MinIO** (ADR-028): auto-deployer dùng endpoint này làm oracle rollback, nên nếu MinIO lôi được nó xuống thì một sự cố lưu trữ sẽ gây rollback nhầm một release đang chạy tốt. MinIO hỏng chỉ hiện ở các endpoint artifact dưới dạng 503. |

## 2. Auth

| Method | Path | Status | Mô tả |
|---|---|---|---|
| POST | `/api/auth/login` | implemented | Body: `{identifier, password}` (identifier = email). Đúng: 200 + account safe fields (id, email, name, role, active) + set cookie `aic_session` (HttpOnly, SameSite theo env, Secure ở production), đồng thời reset số lần sai của identifier. Sai: 401 `INVALID_CREDENTIALS` (generic, không tiết lộ email tồn tại). Account disabled: 403 `ACCOUNT_DISABLED`. Sau 10 lần sai trong cửa sổ 15 phút trên cùng identifier đã normalize: 429 `RATE_LIMITED` + header `Retry-After`; limiter process-local và reset khi API restart. |
| POST | `/api/auth/logout` | implemented | Xóa session server-side + clear cookie. Idempotent: 200 kể cả khi không có session. Trả `{"ok":true}`. |
| GET | `/api/auth/me` | implemented | Trả account safe fields hoặc 401 `UNAUTHORIZED`. Session hết hạn hoặc account bị disable cũng trả 401. |

## 3. Participant - competitions

| Method | Path | Status | Mô tả |
|---|---|---|---|
| GET | `/api/competitions` | implemented | List competition `published` + `closed`, sort theo tên. Đọc công khai (ADR-014): không cần đăng nhập; khách không có phiên nhận `membership = {active:false, joined_at:null}` và không tốn truy vấn membership. Mỗi item có `membership`, `join_code_configured`, `resources` và `submission_config` an toàn: `{ready,id_column,prediction_column,average,max_upload_mb}` - `pos_label` chỉ có với thành viên đang hoạt động (ADR-016). Không trả `created_by`, join-code hash, label data hoặc ground-truth path. |
| GET | `/api/competitions/{slug}` | implemented | Chi tiết competition theo slug với cùng safe fields. Đọc công khai (ADR-014) như danh sách. Draft → 404 `NOT_FOUND` (kể cả khi tồn tại, với mọi đối tượng). Có thêm key `quota` **chỉ khi** người gọi đang đăng nhập, là thành viên active của cuộc thi `published`: `{per_day, used_today, remaining, resets_at}` - đếm bài `completed` trong ngày UTC hiện tại, `resets_at` là 00:00 UTC kế tiếp (ADR-019). List cố ý không tính quota để tránh N+1; guest, non-member và inactive member không nhận key này. |
| POST | `/api/competitions/{slug}/join` | implemented (Sprint 04) | Body `{join_code?}`. Policy backend theo thứ tự (ADR-017): draft/unknown slug → 404; membership inactive → 403 `MEMBERSHIP_INACTIVE`; đã join → 200 idempotent `joined_now:false` (kể cả sau `end_at`/closed); closed → 422 `JOIN_CLOSED`; `now > end_at` → 422 `JOIN_DEADLINE_PASSED`; invite_only → 403 `JOIN_INVITE_ONLY`; mode code thiếu/sai → 403 `JOIN_CODE_INVALID` (cùng message, không tạo oracle). Không kiểm tra `start_at`: join sớm để chuẩn bị là hợp lệ. Thành công → `{competition_id, membership, joined_now}`. |
| POST | `/api/competitions/{slug}/leave` | implemented | Yêu cầu đăng nhập. Rời cuộc thi = đặt membership `active=false` (soft deactivate), cho phép ở cả `published` và `closed`; bài nộp, điểm và thứ hạng đã có được giữ nguyên. Idempotent: gọi lại khi đã rời trả 200 `left_now:false`. Draft/unknown slug → 404; chưa từng join → 404. Trả `{competition_id, membership, left_now}`. Tự join lại sau khi rời vẫn bị 403 `MEMBERSHIP_INACTIVE` - cần admin kích hoạt lại (ADR-018). |
| GET | `/api/competitions/{slug}/contents` | implemented (Sprint 04) | List content metadata sort `order` asc. Đọc công khai (ADR-014): khách chỉ thấy `visibility=public` vì không có membership nào. Draft → 404. |
| GET | `/api/competitions/{slug}/contents/{content_slug}` | implemented (Sprint 04) | Metadata + `markdown` (nội dung file). Không được xem (kể cả members-only với khách hoặc non-member) → 404. File mất → 404 `CONTENT_FILE_MISSING`. |
| GET | `/api/competitions/{slug}/assets/{name}` | implemented (Sprint 04) | Serve ảnh đã upload (PNG/JPEG/GIF/WebP). Headers: `X-Content-Type-Options: nosniff`, `Cache-Control: private, max-age=300`. Traversal/symlink/extension lạ → 404. Đọc công khai (ADR-014) để ảnh trong nội dung public hiển thị với khách; competition phải published/closed. |

## 4. Submissions & leaderboard

| Method | Path | Status | Mô tả |
|---|---|---|---|
| POST | `/api/competitions/{id}/submissions` | implemented (Sprint 05; hai artifact từ ADR-028) | Multipart **hai part bắt buộc**: `file` (CSV, chỉ `.csv` UTF-8/UTF-8 BOM ≤`MAX_UPLOAD_MB`=10 MiB, tối đa 1.000.000 dòng) và `notebook` (`.ipynb` ≤`MAX_NOTEBOOK_MB`=20 MiB). Thiếu một part → 422 `VALIDATION_ERROR` của FastAPI; sai đuôi notebook → 422 `INVALID_NOTEBOOK_TYPE`; notebook không hợp lệ → 422 `NOTEBOOK_INVALID`/`NOTEBOOK_UNSUPPORTED_VERSION`. Backend enforce published + active membership + `start_at <= now <= end_at` + scoring ready + quota completed/ngày UTC. Validate required columns, null, duplicate/missing/extra ID, prediction labels; align theo ID. Trả 201 `{id,competition_id,submission_no,status:"completed",metrics:{f1,precision,recall},primary_score,created_at,quota_remaining,artifacts:{prediction:{filename,size_bytes,available},notebook:{…}}}`. Mọi reject trả 422 **và không upload object nào, không tiêu quota**. MinIO không tới được → 503 `ARTIFACT_STORAGE_UNAVAILABLE` (object của lượt nộp dở đã được dọn). |
| GET | `/api/competitions/{id}/submissions/me` | implemented (Sprint 06) | Query `limit` (1-200, default 50), `offset` (default 0). Chỉ trả lịch sử của account hiện tại trong đúng competition, newest first: `{submissions:[{id,competition_id,submission_no,status,metrics,primary_score,created_at,artifacts,error?}],total,limit,offset}`. `artifacts` là `{prediction, notebook}`, mỗi kind `{filename, size_bytes, available}` hoặc `null`; **không** trả `object_key`, backend lưu trữ hay `file_path`. `submission_no` là `null` với record tạo trước ADR-028. Record legacy chỉ có CSV vẫn hiện `artifacts.prediction` với `size_bytes: null`; `artifacts.notebook` là `null`. |
| GET | `/api/competitions/{id}/submissions/{submission_id}/prediction` | implemented (ADR-028) | Tải CSV dự đoán **của chính mình** (kể cả sau khi rời cuộc thi); bài của đội khác → 404 `NOT_FOUND`. `Content-Disposition` dùng tên chuẩn hoá `{slug}__{account}__submission-{no:04d}__prediction.csv` (legacy thiếu `submission_no` dùng 8 ký tự cuối ObjectId), kèm `filename*=UTF-8''…`; `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`. Object mất → 404 `ARTIFACT_NOT_FOUND`; MinIO không tới được → 503 `ARTIFACT_STORAGE_UNAVAILABLE`. |
| GET | `/api/competitions/{id}/submissions/{submission_id}/notebook` | implemented (ADR-028) | Tải notebook `.ipynb` của chính mình, cùng quy tắc authz/header như route `prediction` (tên `…__notebook.ipynb`). Record legacy không có notebook → 404 `ARTIFACT_NOT_FOUND`. Nội dung notebook **không bao giờ được render hay thực thi** ở server. |
| GET | `/api/competitions/{id}/leaderboard` | implemented (Sprint 06) | Yêu cầu đăng nhập; draft/unknown → 404. Khi `leaderboard_visible=false` → 403 `LEADERBOARD_HIDDEN` và không trả data. Query `limit` (1-200, default 50), `offset` (≥0). Trả `{competition_id,primary_metric,entries,total,limit,offset,has_more,me}`; mỗi entry gồm `rank,display_name,primary_score,metrics,best_submission_id,best_submission_at,total_submissions,is_current_user`, không có email/account_id. `rank` giữ nguyên thứ hạng toàn cục chứ không đánh lại theo trang. `me` là entry của người gọi trên **full** ranking (tìm trước khi cắt trang, nên vẫn có khi ngoài page) hoặc `null` khi chưa có bài `completed`; dùng chung serializer participant nên cũng không có định danh. Chỉ `completed`, mỗi account lấy best; sort score DESC → thời điểm best ASC → account id/submission id để deterministic. |

## 5. Admin (`/api/admin/...`)

### 5.1 Accounts (implemented - Sprint 02)

| Method | Path | Status | Mô tả |
|---|---|---|---|
| GET | `/api/admin/accounts` | implemented | Query: `q` (search email/name, email exact match nếu dạng email), `limit` (1-200, default 50), `offset` (≥0). `limit`/`offset` ngoài khoảng → 422 `VALIDATION_ERROR`. Trả `{accounts: [safe fields], total, limit, offset, stats}` - `total` là số bản ghi khớp `q` (dùng cho phân trang), `stats` là `{total, admin, participant, active}` đếm toàn hệ thống, không phụ thuộc `q`/`limit`/`offset`; account legacy thiếu field `active` được tính là đang hoạt động, khớp `public_account()`. |
| POST | `/api/admin/accounts` | implemented | Body: `{email, name, password, role}` (role: admin\|participant, default participant). Password tối thiểu 10 ký tự, không space đầu/cuối. 201 + account safe fields; 409 `ACCOUNT_EXISTS`; 422 `VALIDATION_ERROR`. |
| POST | `/api/admin/accounts/{id}/reset-password` | implemented | Body: `{password}` (cùng policy). 200 `{"ok":true}`; session hiện tại giữ nguyên; 404 `NOT_FOUND`. |
| PATCH | `/api/admin/accounts/{id}` | implemented | Body: `{active: bool}`. Disable account hủy hiệu lực mọi session của account đó (login bị chặn 403). Không thể tự disable chính mình (422). 200 + account safe fields. |

Mọi endpoint admin yêu cầu role `admin`: 401 `UNAUTHORIZED` nếu chưa đăng nhập, 403 `FORBIDDEN` nếu participant.

### 5.2 Competitions (implemented - Sprint 03)

| Method | Path | Status | Mô tả |
|---|---|---|---|
| GET | `/api/admin/competitions` | implemented | List TẤT CẢ competition (kể cả draft), sort theo tên. Trả `{competitions: [...]}`. |
| POST | `/api/admin/competitions` | implemented | Body: `{slug, name, short_description?, start_at, end_at, join_mode?, primary_metric?, quota_per_day?, leaderboard_visible?, resources?}`. Defaults: join_mode=open, primary_metric=f1, quota_per_day=5, leaderboard_visible=true, resources=[]. Validate: slug `[a-z0-9-]` ≤64 ký tự, start < end, metric f1\|precision\|recall, quota 0-1000, join_mode open\|code\|invite_only, và rule tài nguyên ở §5.6. 201 + admin fields; 409 `SLUG_EXISTS`; 422 `VALIDATION_ERROR`. Tạo xong luôn `draft`. |
| GET | `/api/admin/competitions/{id}` | implemented | Chi tiết theo id (admin xem được mọi status). 404 nếu không tồn tại/id sai. Kèm `publish_ready` và `publish_blocked_reason` (`{code,message}` hoặc `null`) - xem ADR-017. Hai field này là kết quả của **cùng cổng** mà endpoint `/publish` enforce, nên `JOIN_CODE_REQUIRED` cũng xuất hiện ở đây chứ không chỉ ở `/publish`; nhờ vậy banner admin không báo sẵn sàng trong khi nút Publish vẫn bị backend từ chối. Mọi response mutate (create/edit/clone/publish/close) cũng trả hai field này vì UI ghi thẳng response vào state; list thì không, vì readiness phải đọc file ground truth. Kèm `upload_limits: {submission_mb, content_mb, asset_mb}` đọc từ env tại thời điểm request (ADR-011 - trần upload không lưu per competition) để UI render hint đúng giá trị đang áp dụng; cũng chỉ có ở detail/mutate, không có ở list hay payload public. |
| PATCH | `/api/admin/competitions/{id}` | implemented | Sửa config. Rule theo status (ADR-009): draft sửa mọi field trừ slug/status; published không đổi `primary_metric`; closed từ chối mọi sửa đổi (422). 200 + public fields. PATCH chỉ một trong `start_at`/`end_at` vẫn được validate đủ cặp against giá trị hiện có nên lệch thời gian trả 422 `VALIDATION_ERROR` chứ không lỗi 500. |
| POST | `/api/admin/competitions/{id}/publish` | implemented | draft → published. Thứ tự kiểm tra (ADR-017): join code trước (`join_mode=code` mà chưa có mã → 422 `JOIN_CODE_REQUIRED`), rồi readiness (`SCORING_CONFIG_REQUIRED`/`SCORING_CONFIG_INVALID`/`GROUND_TRUTH_REQUIRED`/`GROUND_TRUTH_INVALID`). Readiness đọc và parse lại ground truth thật, không chỉ `is_file()`. Publish thất bại giữ nguyên status `draft`. Sai trạng thái → 422 `INVALID_TRANSITION`. Dùng chung hàm cổng với `publish_blocked_reason` ở detail nên hai chỗ không thể lệch nhau. |
| POST | `/api/admin/competitions/{id}/close` | implemented | published → closed. Đảo được bằng `/reopen` (ADR-027) - closed không còn là terminal. Sai trạng thái → 422 `INVALID_TRANSITION`. |
| POST | `/api/admin/competitions/{id}/reopen` | implemented | closed → published. Chỉ đảo status: KHÔNG kiểm tra lại readiness (cuộc thi đã từng qua cổng publish, đây là hoàn tác chứ không phải publish mới) và KHÔNG đụng `end_at`. draft/published → 422 `INVALID_TRANSITION`. Hai hệ quả cần biết: `end_at` đã qua vẫn chặn join/nộp bài vì hai cổng đó độc lập với status (muốn nhận bài lại thì PATCH `end_at` sau khi mở), và cấu hình chấm điểm/ground truth vẫn khoá nếu cuộc thi đã có submission `completed` (khoá theo dữ liệu, không theo status). |
| POST | `/api/admin/competitions/{id}/clone` | implemented | Clone config thành draft mới, slug tự sinh `<slug>-copy` (-copy2... nếu trùng), dates = now → +1 năm. Copy cả `resources`. KHÔNG copy status/submissions/memberships. 201 + clone. |
| DELETE | `/api/admin/competitions/{id}` | implemented | Query bắt buộc `confirm_slug` - phải khớp `slug` của cuộc thi, nếu thiếu → 422 `VALIDATION_ERROR`, nếu sai → 422 `CONFIRM_SLUG_MISMATCH`. Xoá được `draft` và `closed`; `published` → 409 `COMPETITION_NOT_DELETABLE` ("Cuộc thi đang chạy phải Kết thúc trước khi xoá") - đóng là bước xác nhận có chủ đích trước khi mất lịch sử thi, và cuộc thi đang chạy không bị xoá nhầm (ADR-027). Xoá cascade theo thứ tự con trước – cha sau: submissions → memberships → competition_contents → competition, để nếu một bước lỗi thì bản ghi cuộc thi vẫn còn và gọi lại được (Mongo standalone không có transaction). Sau khi DB xong, dọn best-effort hai thư mục đã containment-check `<DATA_DIR>/competitions/<id>` và `<DATA_DIR>/submissions/<id>`; lỗi file chỉ được log. Trả `{deleted:true, competition_id, slug, files_removed}` - `files_removed:false` nghĩa là DB đã xoá nhưng còn file không dọn được. Accounts/sessions không bị đụng. |

### 5.3 Memberships & join code (implemented - Sprint 04)

| Method | Path | Status | Mô tả |
|---|---|---|---|
| PUT | `/api/admin/competitions/{id}/join-code` | implemented | Body `{join_code}` (8-128 ký tự, không space đầu/cuối). Lưu Argon2id hash; raw code không bao giờ trả về. 200 `{"join_code_configured": true}`. Closed → 422 `INVALID_TRANSITION`. |
| GET | `/api/admin/competitions/{id}/members` | implemented | Query `q`, `limit` (≤200), `offset`. Trả `{members: [{account_id, email, name, role, active, joined_at}], total, active_total, limit, offset}` sort `joined_at`. `total` gồm cả người đã rời/bị vô hiệu hóa; `active_total` là số thành viên đang hoạt động - UI hiển thị cả hai. |
| POST | `/api/admin/competitions/{id}/members` | implemented | Body `{email}`. Idempotent: tạo mới hoặc reactivate membership inactive (giữ `joined_at`), luôn 200 `{member, created, reactivated}`. 404 `ACCOUNT_NOT_FOUND`; 422 nếu account không phải participant active. |
| PATCH | `/api/admin/competitions/{id}/members/{account_id}` | implemented | Body `{active: bool}`. 200 `{member}`; chưa có membership → 404. Đây là cách kích hoạt lại người đã rời cuộc thi. |
| DELETE | `/api/admin/competitions/{id}/members/{account_id}` | implemented | Xoá cứng membership, **chỉ khi** account chưa từng có bài `completed` trong cuộc thi này. Có bài đã chấm điểm → 409 `MEMBER_HAS_SUBMISSIONS`, không xoá gì (hướng dẫn dùng Vô hiệu hóa). Không có membership → 404. Khi được phép: xoá các record bài nộp chưa `completed` cùng file của chúng (best-effort, containment-check) rồi xoá membership sau cùng để lần gọi lại vẫn chạy tiếp được. Không đụng account/session. Trả `{deleted:true, account_id}`. |

### 5.4 Contents & assets (implemented - Sprint 04)

| Method | Path | Status | Mô tả |
|---|---|---|---|
| GET | `/api/admin/competitions/{id}/contents` | implemented | List metadata sort `order` asc, gồm cả `members` visibility. |
| POST | `/api/admin/competitions/{id}/contents` | implemented | Body `{title, slug, order?, visibility?}` (visibility: public\|members, default public; order mặc định max+10). 201; 409 `CONTENT_SLUG_EXISTS`; 422 validation. Chưa có file (`size_bytes: null`). |
| GET | `/api/admin/competitions/{id}/contents/{content_id}` | implemented | Metadata + `markdown` (admin preview mọi visibility). |
| PATCH | `/api/admin/competitions/{id}/contents/{content_id}` | implemented | Partial `{title?, slug?, order?, visibility?}`. 409 `CONTENT_SLUG_EXISTS`. |
| PUT | `/api/admin/competitions/{id}/contents/{content_id}/file` | implemented | Multipart `file` - chỉ `.md`, UTF-8, không rỗng, ≤`MAX_CONTENT_MB` (2 MiB). Tên file gốc không dùng làm path (backend sinh `<content_id>.md`). 422 `INVALID_FILE_TYPE`/`VALIDATION_ERROR`; 413 `FILE_TOO_LARGE`. |
| POST | `/api/admin/competitions/{id}/contents/reorder` | implemented | Body `{items: [{id, order}]}` - id phải thuộc competition, không trùng. 200 list mới. |
| DELETE | `/api/admin/competitions/{id}/contents/{content_id}` | implemented | Xóa metadata + file best-effort. 200 `{"ok": true}`. |
| GET | `/api/admin/competitions/{id}/assets` | implemented | List ảnh từ thư mục assets (tên backend sinh, không có DB collection). |
| POST | `/api/admin/competitions/{id}/assets` | implemented | Multipart `file` - PNG/JPEG/GIF/WebP (sniff magic bytes, không tin MIME header), ≤`MAX_ASSET_MB` (2 MiB), không SVG. Tên sinh `uuid4.<ext>`. 201 `{name, size_bytes, content_type, url}`. |
| DELETE | `/api/admin/competitions/{id}/assets/{name}` | implemented | 200 `{"ok": true}`; tên không hợp lệ/không tồn tại → 404. |

### 5.5 Ground truth, submissions view, leaderboard, export

| Method | Path | Status | Mô tả |
|---|---|---|---|
| GET | `/api/admin/competitions/{id}/scoring` | implemented (Sprint 05) | Trả `{ready,locked,config,ground_truth,primary_metric,quota_per_day,max_upload_mb}`. `ground_truth` chỉ có row count, column names, uploaded time; không có labels/path/download. |
| PUT | `/api/admin/competitions/{id}/scoring` | implemented (Sprint 05) | Body `{id_column,prediction_column,label_column,average,pos_label,higher_is_better:true}`. Average chỉ binary\|macro\|weighted; binary bắt buộc pos_label, loại khác phải null. Nếu đã có ground truth thì config mới phải validate được file hiện tại trước khi lưu. |
| PUT | `/api/admin/competitions/{id}/ground-truth` | implemented (Sprint 05) | Multipart CSV private. Bắt buộc lưu scoring config trước; validate UTF-8/schema/ID/labels ngay, sau đó atomic replace file. Closed hoặc đã có submission completed → 422 `SCORING_LOCKED`. |
| GET | `/api/admin/competitions/{id}/submissions` | implemented (Sprint 06; sort từ ADR-028) | Query `q` (tên/email), `status` (`completed|rejected|failed`), `sort` (`created_at`\|`team`\|`primary_score`, default `created_at`), `order` (`asc`\|`desc`, default `desc`), `limit` (1-200, default 50), `offset`. Trả `{submissions:[{id,competition_id,submission_no,status,metrics,primary_score,created_at,artifacts,error?,account:{id,name,email}}],total,limit,offset,sort,order}` trong đúng competition. Không trả `object_key`/`file_path`. `sort`/`order` sai → 422 `VALIDATION_ERROR`. |
| GET | `/api/admin/submissions` | implemented (ADR-028) | Bảng bài nộp **toàn cục**. Query: `competition_id` (ObjectId, sai định dạng → 422 `VALIDATION_ERROR`), `q`, `status`, `sort`, `order`, `limit`, `offset` như trên. Trả cùng shape, mỗi item thêm `competition: {id, slug, name}`; cuộc thi đã bị xoá → `{id, slug:"", name:"Cuộc thi đã xóa"}`, account đã xoá → `{id, name:"Tài khoản đã xóa", email:""}` (không 500, để bảng còn dùng được). |
| GET | `/api/admin/submissions/{submission_id}/prediction` | implemented (ADR-028) | Admin tải CSV của **bất kỳ** đội nào, cùng tên chuẩn hoá/header như route participant. Không giới hạn theo competition đang xem. 404 `NOT_FOUND` khi submission/cuộc thi không tồn tại. |
| GET | `/api/admin/submissions/{submission_id}/notebook` | implemented (ADR-028) | Admin tải notebook của bất kỳ đội nào; cùng quy tắc như route `prediction`. |
| GET | `/api/admin/competitions/{id}/leaderboard` | implemented (Sprint 06) | Admin xem cùng ranking kể cả khi participant leaderboard ẩn. Entry thêm `account_id`, không trả email. |
| GET | `/api/admin/competitions/{id}/export.xlsx` | implemented (Sprint 06) | Download workbook `.xlsx`, filename `<safe-slug>-results-<UTC timestamp>.xlsx`, một sheet `Results`: Rank, Account ID, Team name, Best score, F1, Precision, Recall, Best submission time, Total submissions. Chỉ completed/best result của đúng competition; không chứa email, server path, password/session hoặc ground truth. Text được neutralize formula và ký tự Excel không hợp lệ. |

### 5.6 Competition resources (link Google Drive, không upload binary)

`competitions.resources` là danh sách `{label, url}` do admin khai báo, hiển thị cho participant ở block "Tài nguyên tải về" trong tab Tổng quan (ADR-015). Nền tảng **không** host dataset/binary; chỉ lưu và validate link.

- Tối đa 10 mục (`RESOURCES_MAX`).
- `label`: bắt buộc sau khi trim, tối đa 120 ký tự.
- `url`: bắt buộc, tối đa 2048 ký tự, scheme phải là `https`, không được chứa credentials (`user:pass@`), host phải là `drive.google.com` hoặc `docs.google.com` (hoặc subdomain của chúng).
- Gửi `resources: []` để xoá hết. Document cũ thiếu field được serialize thành `[]` - không cần migration Mongo.
- Vi phạm → 422 `VALIDATION_ERROR` với message tiếng Việt nêu đúng rule.
- Field này có trong cả public và admin representation, không chứa dữ liệu nhạy cảm.

## 6. Error codes

- `UNAUTHORIZED` (401), `FORBIDDEN` (403) - implemented
- `INVALID_CREDENTIALS` (401), `ACCOUNT_DISABLED` (403), `ACCOUNT_EXISTS` (409), `RATE_LIMITED` (429) - implemented
- `SLUG_EXISTS` (409), `INVALID_TRANSITION` (422) - implemented (Sprint 03)
- `JOIN_CLOSED` (422), `JOIN_CODE_INVALID` (403), `JOIN_INVITE_ONLY` (403), `MEMBERSHIP_INACTIVE` (403), `JOIN_CODE_REQUIRED` (422), `ACCOUNT_NOT_FOUND` (404), `CONTENT_SLUG_EXISTS` (409), `CONTENT_FILE_MISSING` (404), `INVALID_FILE_TYPE` (422), `FILE_TOO_LARGE` (413) - implemented (Sprint 04)
- `NOT_FOUND` (404), `VALIDATION_ERROR` (422) - implemented
- `SCORING_CONFIG_REQUIRED`, `SCORING_CONFIG_INVALID`, `SCORING_NOT_READY`, `SCORING_LOCKED`, `GROUND_TRUTH_INVALID` - implemented (Sprint 05)
- `SUBMISSION_SCHEMA_INVALID`, `SUBMISSION_DUPLICATE_IDS`, `SUBMISSION_ID_MISMATCH`, `SUBMISSION_VALUE_INVALID`, `SUBMISSION_QUOTA_EXCEEDED` (429), `SUBMISSION_NOT_OPEN`, `SUBMISSION_DEADLINE_PASSED`, `SUBMISSION_CLOSED`, `MEMBERSHIP_REQUIRED` - implemented (Sprint 05)
- `LEADERBOARD_HIDDEN` (403) - implemented (Sprint 06)
- `METHOD_NOT_ALLOWED` (405), `HTTP_ERROR` (generic non-contract 4xx), `INTERNAL_ERROR` (500) - implemented (Sprint 07); unhandled server errors luôn trả message generic, không trả traceback/detail nội bộ
- `FILE_WRITE_FAILED`, `SUBMISSION_SAVE_FAILED`, `SCORING_FAILED` (500) - implemented cho failure mode lưu/chấm bài; message public generic, chi tiết chỉ ở server log
- `JOIN_DEADLINE_PASSED` (422) - non-member join sau `end_at`; `GROUND_TRUTH_REQUIRED` (422) - publish khi thiếu ground truth (ADR-017)
- `INVALID_NOTEBOOK_TYPE`, `NOTEBOOK_INVALID`, `NOTEBOOK_UNSUPPORTED_VERSION` (422), `ARTIFACT_NOT_FOUND` (404), `ARTIFACT_TOO_LARGE` (413), `ARTIFACT_STORAGE_UNAVAILABLE` (503), `ARTIFACT_READ_FAILED` (500) - artifact của submission (ADR-028). `ARTIFACT_STORAGE_UNAVAILABLE` là mã **duy nhất** mà một sự cố MinIO tạo ra: `/api/health` cố ý không phụ thuộc MinIO nên nó không bao giờ báo `degraded` vì MinIO.
- `CONFIRM_SLUG_MISMATCH` (422), `COMPETITION_NOT_DELETABLE` (409), `MEMBER_HAS_SUBMISSIONS` (409) - luồng xoá (ADR-018). `COMPETITION_NOT_DELETABLE` giờ chỉ còn cho `published`: `closed` xoá được nên xoá cuộc thi không còn là "luôn giữ lịch sử" (ADR-027)
