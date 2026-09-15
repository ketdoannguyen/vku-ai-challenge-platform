# Master Context - AI Challenge Platform

## 1. Product goal
Xây dựng nền tảng AI Challenge nhỏ-gọn, có thể tái sử dụng cho nhiều cuộc thi trên cùng một website.

MVP ban đầu phục vụ khoảng 40-80 đội/người dùng mỗi đợt. Submission là file kết quả CSV; server KHÔNG chạy model của thí sinh.

## 2. Roles
### Admin
- Tạo tài khoản/đội thi.
- Tạo, sửa, clone, publish, close competition.
- Cấu hình thời gian, join mode, quota, scoring.
- Upload Markdown, assets, ground truth.
- Quản lý membership.
- Xem submission và lỗi scoring.
- Export Excel.

### Participant/Team
- Không tự đăng ký tài khoản.
- Đăng nhập bằng tài khoản BTC cấp.
- Xem competition có thể tham gia.
- Join competition nếu đúng policy.
- Đọc content Markdown.
- Nộp CSV.
- Xem metrics, lịch sử submission và leaderboard theo competition.

## 3. Architecture locked for MVP
Không tự ý đổi architecture nếu chưa hỏi người dùng.

- Hosting/runtime: 01 Google Compute Engine VM.
- OS production: Ubuntu Server LTS.
- Container orchestration: Docker Compose.
- Public edge: Cloudflare + Cloudflare Tunnel.
- Frontend: React + Vite + TypeScript.
- UI: custom clean responsive UI, không cần heavy UI framework.
- Web server/reverse proxy: Nginx.
- Backend: FastAPI + Python.
- Database: MongoDB.
- Files: persistent disk trên VM.
- Auth: account trong MongoDB + Argon2id password hash + server-side session.
- Session transport: HttpOnly + Secure + SameSite cookie.
- Scoring MVP: classification CSV -> F1, Precision, Recall.
- Excel export: backend tạo `.xlsx`.
- No Firebase, no Firestore, no Cloud Run, no Kubernetes, no message queue trong MVP.

## 4. UX direction
Competition page mang tính chất giống một contest portal:
- Competition header: tên, status, thời gian/deadline, thông tin ngắn.
- Navigation rõ ràng: Overview/Get Started, Problem, Rules, Submission Guide, My Submissions, Leaderboard/Results.
- Content Markdown nằm trong main content area, có heading, list, table, code block, link, image.
- Sidebar/menu Markdown có thể sinh động từ metadata content.
- Submit CSV là thao tác rõ ràng, thông báo validate/scoring dễ hiểu.
- Admin UI đơn giản, không trang trí quá mức; ưu tiên thao tác và tính minh bạch.
- Responsive tốt trên laptop; mobile dùng được nhưng desktop là mục tiêu chính.

## 5. Competition as central entity
Mọi dữ liệu nghiệp vụ sau phải gắn `competition_id`:
- memberships
- content
- submissions
- scoring config
- ground truth path
- leaderboard behavior
- export

Không được hard-code tên `AI Challenge 2026` vào logic.

## 6. Account model
- Tài khoản dùng chung trên toàn platform.
- BTC tạo sẵn; no self-registration.
- Một account có thể join nhiều competitions.
- Role MVP: `admin`, `participant`.
- Account có `active` để khóa toàn nền tảng.
- Membership có `active` để khóa trong riêng một competition.

## 7. Competition lifecycle
Trạng thái MVP:
- `draft`: chỉ admin quản lý, participant không thấy.
- `published`: participant phù hợp có thể xem/join.
- `closed`: không nhận submission mới; nội dung/leaderboard tùy config vẫn có thể xem.

Không tự động chèn workflow phức tạp khác nếu chưa cần.

## 8. Join modes MVP
Hỗ trợ tối thiểu:
- `open`: account đã login có thể join.
- `code`: cần join code hợp lệ.
- `invite_only`: admin thêm membership trước; user không tự join.

Join code không được trả về participant API sau khi competition publish.

## 9. Markdown content
Mỗi competition có nhiều content page.
Metadata tối thiểu:
- title
- slug
- order
- markdown_path
- visibility

Markdown được lưu trên disk, metadata lưu MongoDB.
Frontend render Markdown an toàn, hỗ trợ GFM cơ bản.
HTML nguy hiểm phải sanitize/disable.
Asset chỉ được lấy từ thư mục public assets của competition; cấm path traversal.

## 10. Submission/scoring MVP
MVP chỉ nhận `.csv`.

Scoring configuration phải cho phép khai báo tối thiểu:
- `id_column`
- `prediction_column`
- `label_column` trong ground truth
- `average`: binary/macro/weighted (chỉ các giá trị được hỗ trợ)
- `pos_label` nếu binary
- `primary_metric`: f1/precision/recall
- `higher_is_better`: true cho MVP
- quota submissions/day
- max upload size

Validation bắt buộc:
- extension/type hợp lệ
- file đọc được
- cột bắt buộc tồn tại
- ID không duplicate
- ID của submission khớp tập ID ground truth theo rule đã chốt
- prediction không null
- dữ liệu có thể tính metric

Scoring:
- Align theo `id`, không dựa vào thứ tự dòng.
- Tính F1/Precision/Recall cùng một config.
- `zero_division=0` hoặc equivalent để tránh crash; contract phải ghi rõ.
- Lưu cả `metrics` và `primary_score`.
- Leaderboard lấy best valid submission của mỗi account trong competition.

Nếu bài thi thực tế cần schema khác, AI phải dừng và hỏi trước khi mở rộng engine.

## 11. File storage layout
Source of truth file system:

    /data/
      competitions/<competition_id>/
        content/
        assets/
        private/
          ground_truth.csv
          scoring_config.json
      submissions/<competition_id>/<account_id>/
      backups/

Private files KHÔNG được Nginx serve.
Backend phải validate path và không cho `..`/absolute path từ input user.

## 12. MongoDB collections MVP
- accounts
- sessions
- competitions
- competition_memberships
- competition_contents
- submissions

Indexes và unique constraints được định nghĩa trong `02_ARCHITECTURE_CONTRACTS.md` và cập nhật trong repo.

## 13. Security non-negotiable
- Password không plaintext.
- Session token ngẫu nhiên, entropy cao; không log raw token.
- MongoDB port không expose public.
- Ground truth không public.
- Admin endpoint check role ở backend.
- Membership/deadline/quota check ở backend; frontend chỉ là UX.
- Markdown sanitize.
- Upload size/schema check.
- Production secret chỉ nằm server `.env` hoặc secret mechanism phù hợp; repo chỉ có `.env.example`.
- Nginx thêm security headers cơ bản.
- Log không chứa password, cookie, secret, ground truth.

## 14. Simplicity constraints
Không thêm nếu chưa có lý do thực tế:
- Redis
- Celery/RQ
- Kafka/RabbitMQ
- microservices
- GraphQL
- Kubernetes
- external object storage
- Elasticsearch
- OAuth/social login
- realtime websocket

## 15. Canonical project docs in repo
Từ Sprint 00, repo phải có:
- `docs/PROJECT_STATE.md`
- `docs/DECISIONS.md`
- `docs/API_CONTRACT.md`
- `docs/DATA_MODEL.md`
- `docs/TEST_MATRIX.md`
- `docs/DEPLOYMENT.md` (được hoàn thiện dần)

Mỗi sprint có trách nhiệm giữ các file này đồng bộ với code.

