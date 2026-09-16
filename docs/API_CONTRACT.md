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
| GET | `/api/health` | implemented | Trả `{"status":"ok","mongo":"reachable"}` + 200 khi Mongo reachable; `{"status":"degraded","mongo":"unreachable"}` + 503 khi không. Không expose thông tin nội bộ. |

## 2. Auth

| Method | Path | Status | Mô tả |
|---|---|---|---|
| POST | `/api/auth/login` | implemented | Body: `{identifier, password}` (identifier = email). Đúng: 200 + account safe fields (id, email, name, role, active) + set cookie `aic_session` (HttpOnly, SameSite=lax, Secure ở production). Sai: 401 `INVALID_CREDENTIALS` (generic, không tiết lộ email tồn tại). Account disabled: 403 `ACCOUNT_DISABLED`. |
| POST | `/api/auth/logout` | implemented | Xóa session server-side + clear cookie. Idempotent: 200 kể cả khi không có session. Trả `{"ok":true}`. |
| GET | `/api/auth/me` | implemented | Trả account safe fields hoặc 401 `UNAUTHORIZED`. Session hết hạn hoặc account bị disable cũng trả 401. |

## 3. Participant - competitions

| Method | Path | Status | Mô tả |
|---|---|---|---|
| GET | `/api/competitions` | implemented | List competition `published` + `closed`, sort theo tên. Yêu cầu đăng nhập (401 nếu không). Mỗi item có `membership`, `join_code_configured` và `submission_config` an toàn: `{ready,id_column,prediction_column,average,pos_label,max_upload_mb}`. Không trả join-code hash, label data hoặc ground-truth path. |
| GET | `/api/competitions/{slug}` | implemented | Chi tiết competition theo slug với cùng safe fields. Draft → 404 `NOT_FOUND` (kể cả khi tồn tại). |
| POST | `/api/competitions/{slug}/join` | implemented (Sprint 04) | Body `{join_code?}`. Policy backend: draft/unknown slug → 404; closed → 422 `JOIN_CLOSED`; đã join → 200 idempotent `joined_now:false`; membership inactive → 403 `MEMBERSHIP_INACTIVE` (chỉ admin kích hoạt lại); invite_only → 403 `JOIN_INVITE_ONLY`; mode code thiếu/sai → 403 `JOIN_CODE_INVALID` (cùng message, không tạo oracle). Thành công → `{competition_id, membership, joined_now}`. |
| GET | `/api/competitions/{slug}/contents` | implemented (Sprint 04) | List content metadata sort `order` asc. Chỉ `visibility=public` hoặc member active thấy `members`. Draft → 404. |
| GET | `/api/competitions/{slug}/contents/{content_slug}` | implemented (Sprint 04) | Metadata + `markdown` (nội dung file). Không được xem (kể cả members-only non-member) → 404. File mất → 404 `CONTENT_FILE_MISSING`. |
| GET | `/api/competitions/{slug}/assets/{name}` | implemented (Sprint 04) | Serve ảnh đã upload (PNG/JPEG/GIF/WebP). Headers: `X-Content-Type-Options: nosniff`, `Cache-Control: private, max-age=300`. Traversal/symlink/extension lạ → 404. Yêu cầu đăng nhập; competition phải published/closed. |

## 4. Submissions & leaderboard

| Method | Path | Status | Mô tả |
|---|---|---|---|
| POST | `/api/competitions/{id}/submissions` | implemented (Sprint 05) | Multipart `file`. Chỉ `.csv` UTF-8/UTF-8 BOM ≤`MAX_UPLOAD_MB` (10 MiB), tối đa 1.000.000 dòng. Backend enforce published + active membership + `start_at <= now <= end_at` + scoring ready + quota completed/ngày UTC. Validate required columns, null, duplicate/missing/extra ID, prediction labels; align theo ID; trả 201 `{id,competition_id,status:"completed",metrics:{f1,precision,recall},primary_score,created_at,quota_remaining}`. Validation reject trả 422 và không lưu record/file. |
| GET | `/api/competitions/{id}/submissions/me` | implemented (Sprint 06) | Query `limit` (1-200, default 50), `offset` (default 0). Chỉ trả lịch sử của account hiện tại trong đúng competition, newest first: `{submissions:[{id,competition_id,filename,status,metrics,primary_score,created_at,error?}],total,limit,offset}`. Không trả `account_id` hoặc `file_path`. `error` chỉ xuất hiện cho record lỗi tương thích; upload Sprint 05 vẫn không persist validation-rejected. |
| GET | `/api/competitions/{id}/leaderboard` | implemented (Sprint 06) | Yêu cầu đăng nhập; draft/unknown → 404. Khi `leaderboard_visible=false` → 403 `LEADERBOARD_HIDDEN` và không trả data. Khi visible, trả `{competition_id,primary_metric,entries,total}`; mỗi entry gồm `rank,display_name,primary_score,metrics,best_submission_id,best_submission_at,total_submissions,is_current_user`, không có email/account_id. Chỉ `completed`, mỗi account lấy best; sort score DESC → thời điểm best ASC → account id/submission id để deterministic. |

## 5. Admin (`/api/admin/...`)

### 5.1 Accounts (implemented — Sprint 02)

| Method | Path | Status | Mô tả |
|---|---|---|---|
| GET | `/api/admin/accounts` | implemented | Query: `q` (search email/name, email exact match nếu dạng email), `limit` (≤200, default 50), `offset`. Trả `{accounts: [safe fields], total, limit, offset}`. |
| POST | `/api/admin/accounts` | implemented | Body: `{email, name, password, role}` (role: admin\|participant, default participant). Password tối thiểu 10 ký tự, không space đầu/cuối. 201 + account safe fields; 409 `ACCOUNT_EXISTS`; 422 `VALIDATION_ERROR`. |
| POST | `/api/admin/accounts/{id}/reset-password` | implemented | Body: `{password}` (cùng policy). 200 `{"ok":true}`; session hiện tại giữ nguyên; 404 `NOT_FOUND`. |
| PATCH | `/api/admin/accounts/{id}` | implemented | Body: `{active: bool}`. Disable account hủy hiệu lực mọi session của account đó (login bị chặn 403). Không thể tự disable chính mình (422). 200 + account safe fields. |

Mọi endpoint admin yêu cầu role `admin`: 401 `UNAUTHORIZED` nếu chưa đăng nhập, 403 `FORBIDDEN` nếu participant.

### 5.2 Competitions (implemented — Sprint 03)

| Method | Path | Status | Mô tả |
|---|---|---|---|
| GET | `/api/admin/competitions` | implemented | List TẤT CẢ competition (kể cả draft), sort theo tên. Trả `{competitions: [...]}`. |
| POST | `/api/admin/competitions` | implemented | Body: `{slug, name, short_description?, start_at, end_at, join_mode?, primary_metric?, quota_per_day?, leaderboard_visible?}`. Defaults: join_mode=open, primary_metric=f1, quota_per_day=5, leaderboard_visible=true. Validate: slug `[a-z0-9-]` ≤64 ký tự, start < end, metric f1\|precision\|recall, quota 0-1000, join_mode open\|code\|invite_only. 201 + public fields; 409 `SLUG_EXISTS`; 422 `VALIDATION_ERROR`. Tạo xong luôn `draft`. |
| GET | `/api/admin/competitions/{id}` | implemented | Chi tiết theo id (admin xem được mọi status). 404 nếu không tồn tại/id sai. |
| PATCH | `/api/admin/competitions/{id}` | implemented | Sửa config. Rule theo status (ADR-009): draft sửa mọi field trừ slug/status; published không đổi `primary_metric`; closed từ chối mọi sửa đổi (422). 200 + public fields. |
| POST | `/api/admin/competitions/{id}/publish` | implemented | draft → published. Sai trạng thái → 422 `INVALID_TRANSITION`. |
| POST | `/api/admin/competitions/{id}/close` | implemented | published → closed (terminal, không reopen ở MVP). Sai trạng thái → 422 `INVALID_TRANSITION`. |
| POST | `/api/admin/competitions/{id}/clone` | implemented | Clone config thành draft mới, slug tự sinh `<slug>-copy` (-copy2... nếu trùng), dates = now → +1 năm. KHÔNG copy status/submissions/memberships. 201 + clone. |

### 5.3 Memberships & join code (implemented — Sprint 04)

| Method | Path | Status | Mô tả |
|---|---|---|---|
| PUT | `/api/admin/competitions/{id}/join-code` | implemented | Body `{join_code}` (8-128 ký tự, không space đầu/cuối). Lưu Argon2id hash; raw code không bao giờ trả về. 200 `{"join_code_configured": true}`. Closed → 422 `INVALID_TRANSITION`. |
| GET | `/api/admin/competitions/{id}/members` | implemented | Query `q`, `limit` (≤200), `offset`. Trả `{members: [{account_id, email, name, role, active, joined_at}], total, limit, offset}` sort `joined_at`. |
| POST | `/api/admin/competitions/{id}/members` | implemented | Body `{email}`. Idempotent: tạo mới hoặc reactivate membership inactive (giữ `joined_at`), luôn 200 `{member, created, reactivated}`. 404 `ACCOUNT_NOT_FOUND`; 422 nếu account không phải participant active. |
| PATCH | `/api/admin/competitions/{id}/members/{account_id}` | implemented | Body `{active: bool}`. 200 `{member}`; chưa có membership → 404. |

### 5.4 Contents & assets (implemented — Sprint 04)

| Method | Path | Status | Mô tả |
|---|---|---|---|
| GET | `/api/admin/competitions/{id}/contents` | implemented | List metadata sort `order` asc, gồm cả `members` visibility. |
| POST | `/api/admin/competitions/{id}/contents` | implemented | Body `{title, slug, order?, visibility?}` (visibility: public\|members, default public; order mặc định max+10). 201; 409 `CONTENT_SLUG_EXISTS`; 422 validation. Chưa có file (`size_bytes: null`). |
| GET | `/api/admin/competitions/{id}/contents/{content_id}` | implemented | Metadata + `markdown` (admin preview mọi visibility). |
| PATCH | `/api/admin/competitions/{id}/contents/{content_id}` | implemented | Partial `{title?, slug?, order?, visibility?}`. 409 `CONTENT_SLUG_EXISTS`. |
| PUT | `/api/admin/competitions/{id}/contents/{content_id}/file` | implemented | Multipart `file` — chỉ `.md`, UTF-8, không rỗng, ≤`MAX_CONTENT_MB` (2 MiB). Tên file gốc không dùng làm path (backend sinh `<content_id>.md`). 422 `INVALID_FILE_TYPE`/`VALIDATION_ERROR`; 413 `FILE_TOO_LARGE`. |
| POST | `/api/admin/competitions/{id}/contents/reorder` | implemented | Body `{items: [{id, order}]}` — id phải thuộc competition, không trùng. 200 list mới. |
| DELETE | `/api/admin/competitions/{id}/contents/{content_id}` | implemented | Xóa metadata + file best-effort. 200 `{"ok": true}`. |
| GET | `/api/admin/competitions/{id}/assets` | implemented | List ảnh từ thư mục assets (tên backend sinh, không có DB collection). |
| POST | `/api/admin/competitions/{id}/assets` | implemented | Multipart `file` — PNG/JPEG/GIF/WebP (sniff magic bytes, không tin MIME header), ≤`MAX_ASSET_MB` (2 MiB), không SVG. Tên sinh `uuid4.<ext>`. 201 `{name, size_bytes, content_type, url}`. |
| DELETE | `/api/admin/competitions/{id}/assets/{name}` | implemented | 200 `{"ok": true}`; tên không hợp lệ/không tồn tại → 404. |

### 5.5 Ground truth, submissions view, leaderboard, export

| Method | Path | Status | Mô tả |
|---|---|---|---|
| GET | `/api/admin/competitions/{id}/scoring` | implemented (Sprint 05) | Trả `{ready,locked,config,ground_truth,primary_metric,quota_per_day,max_upload_mb}`. `ground_truth` chỉ có row count, column names, uploaded time; không có labels/path/download. |
| PUT | `/api/admin/competitions/{id}/scoring` | implemented (Sprint 05) | Body `{id_column,prediction_column,label_column,average,pos_label,higher_is_better:true}`. Average chỉ binary\|macro\|weighted; binary bắt buộc pos_label, loại khác phải null. Nếu đã có ground truth thì config mới phải validate được file hiện tại trước khi lưu. |
| PUT | `/api/admin/competitions/{id}/ground-truth` | implemented (Sprint 05) | Multipart CSV private. Bắt buộc lưu scoring config trước; validate UTF-8/schema/ID/labels ngay, sau đó atomic replace file. Closed hoặc đã có submission completed → 422 `SCORING_LOCKED`. |
| GET | `/api/admin/competitions/{id}/submissions` | implemented (Sprint 06) | Query `q` (tên/email), `status` (`completed|rejected|failed`), `limit` (1-200, default 50), `offset`. Trả newest first `{submissions:[{id,competition_id,filename,status,metrics,primary_score,created_at,error?,account:{id,name,email}}],total,limit,offset}` trong đúng competition. Không trả `file_path`; không có endpoint download CSV submission. |
| GET | `/api/admin/competitions/{id}/leaderboard` | implemented (Sprint 06) | Admin xem cùng ranking kể cả khi participant leaderboard ẩn. Entry thêm `account_id`, không trả email. |
| GET | `/api/admin/competitions/{id}/export.xlsx` | implemented (Sprint 06) | Download workbook `.xlsx`, filename `<safe-slug>-results-<UTC timestamp>.xlsx`, một sheet `Results`: Rank, Account ID, Team name, Best score, F1, Precision, Recall, Best submission time, Total submissions. Chỉ completed/best result của đúng competition; không chứa email, server path, password/session hoặc ground truth. Text được neutralize formula và ký tự Excel không hợp lệ. |

## 6. Error codes

- `UNAUTHORIZED` (401), `FORBIDDEN` (403) — implemented
- `INVALID_CREDENTIALS` (401), `ACCOUNT_DISABLED` (403), `ACCOUNT_EXISTS` (409) — implemented
- `SLUG_EXISTS` (409), `INVALID_TRANSITION` (422) — implemented (Sprint 03)
- `JOIN_CLOSED` (422), `JOIN_CODE_INVALID` (403), `JOIN_INVITE_ONLY` (403), `MEMBERSHIP_INACTIVE` (403), `JOIN_CODE_REQUIRED` (422), `ACCOUNT_NOT_FOUND` (404), `CONTENT_SLUG_EXISTS` (409), `CONTENT_FILE_MISSING` (404), `INVALID_FILE_TYPE` (422), `FILE_TOO_LARGE` (413) — implemented (Sprint 04)
- `NOT_FOUND` (404), `VALIDATION_ERROR` (422) — implemented
- `SCORING_CONFIG_REQUIRED`, `SCORING_CONFIG_INVALID`, `SCORING_NOT_READY`, `SCORING_LOCKED`, `GROUND_TRUTH_INVALID` — implemented (Sprint 05)
- `SUBMISSION_SCHEMA_INVALID`, `SUBMISSION_DUPLICATE_IDS`, `SUBMISSION_ID_MISMATCH`, `SUBMISSION_VALUE_INVALID`, `SUBMISSION_QUOTA_EXCEEDED` (429), `SUBMISSION_NOT_OPEN`, `SUBMISSION_DEADLINE_PASSED`, `SUBMISSION_CLOSED`, `MEMBERSHIP_REQUIRED` — implemented (Sprint 05)
- `LEADERBOARD_HIDDEN` (403) — implemented (Sprint 06)
