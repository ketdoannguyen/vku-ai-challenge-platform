# AI Challenge Platform - Sprint Implementation Pack v1.0

## 1. Mục đích
Bộ tài liệu này dùng để giao cho AI coding agent phát triển toàn bộ nền tảng AI Challenge từ repo ban đầu đến production, theo từng sprint độc lập nhưng liên thông.

Nền tảng mục tiêu:
- Một website dùng chung cho nhiều cuộc thi AI.
- Ban Tổ chức tạo competition từ Admin, không hard-code từng mùa thi.
- Tài khoản do Ban Tổ chức cấp sẵn, không có self-registration.
- Người dùng đăng nhập, xem/join competition, đọc đề bài và rules render từ Markdown, nộp CSV, nhận F1/Precision/Recall, xem My Submissions và Leaderboard.
- Toàn bộ runtime trên 01 Google Compute Engine VM bằng Docker Compose.
- Cloudflare Tunnel công khai website; MongoDB lưu dữ liệu nghiệp vụ; persistent disk lưu Markdown, assets, ground truth, submissions và backups.

## 2. Cách dùng bộ sprint
Khuyến nghị copy nguyên thư mục này vào repo tại:

    plans/

Sau đó thực hiện ĐÚNG THỨ TỰ:

1. Đọc `01_MASTER_CONTEXT.md`.
2. Đọc `02_ARCHITECTURE_CONTRACTS.md`.
3. Đọc `03_PROJECT_STATE_TEMPLATE.md`.
4. Đọc `04_SPRINT_MAP.md`.
5. Chạy Sprint 00, sau đó lần lượt Sprint 01 -> Sprint 09.
6. Mỗi lần bắt đầu sprint, dùng prompt trong `90_MASTER_AI_CODING_PROMPT.md` và gắn tên file sprint cần làm.
7. Không cho AI tự động làm tiếp sprint kế tiếp sau khi hoàn thành sprint hiện tại.

## 3. Cơ chế giữ ngữ cảnh giữa các sprint
Đây là quy tắc BẮT BUỘC để tránh AI mất ngữ cảnh:

### Nguồn sự thật của dự án
Thứ tự ưu tiên khi có mâu thuẫn:
1. Code và config đang tồn tại trong repo.
2. `docs/PROJECT_STATE.md`.
3. `docs/DECISIONS.md`.
4. `docs/API_CONTRACT.md` và `docs/DATA_MODEL.md`.
5. File sprint hiện tại.
6. Tài liệu plan tổng thể.

AI không được dựa vào lịch sử chat làm nguồn sự thật chính.

### Cuối mỗi sprint
AI bắt buộc cập nhật:
- `docs/PROJECT_STATE.md`
- `docs/API_CONTRACT.md` nếu API thay đổi
- `docs/DATA_MODEL.md` nếu schema/index thay đổi
- `docs/DECISIONS.md` nếu có quyết định mới
- README nếu lệnh chạy/deploy thay đổi

`PROJECT_STATE.md` phải ghi rõ:
- Sprint vừa hoàn thành.
- Chức năng đã có thật.
- File/module quan trọng.
- API đã có.
- Collections/indexes đã có.
- Biến môi trường mới.
- Lệnh chạy/test đã xác minh.
- Known issues.
- Điều kiện để bắt đầu sprint tiếp theo.

### Đầu mỗi sprint
AI bắt buộc:
- Đọc các file trên.
- `git status` và xem cấu trúc repo thực tế.
- Kiểm tra sprint trước đã đạt acceptance criteria chưa.
- Nếu state trong tài liệu không khớp code: DỪNG, báo mâu thuẫn và hỏi người dùng.

## 4. Nguyên tắc code
- Ưu tiên code ngắn, rõ, dễ đọc, dễ debug.
- Không tạo abstraction nếu chỉ có một nơi sử dụng và chưa có nhu cầu thực tế.
- Không over-engineering, không microservice hóa.
- Không tạo package/layer phức tạp nếu standard library hoặc một hàm nhỏ là đủ.
- Mỗi module có một trách nhiệm rõ ràng.
- Tên biến/hàm/route rõ nghĩa.
- Không để TODO giả, mock giả hoặc placeholder trong luồng production.
- Không refactor ngoài phạm vi sprint nếu không cần cho acceptance criteria.
- Mỗi thay đổi nghiệp vụ quan trọng phải có test.
- Lỗi trả về cho user phải dễ hiểu; log server phải hữu ích nhưng không lộ secret.
- README chỉ ghi những gì cần để setup/run/test/deploy; không viết dài dòng.

## 5. Nguyên tắc hỏi người dùng
AI phải DỪNG và hỏi nếu gặp một trong các tình huống:
- Cần credential, domain, VM, Cloudflare token mà chưa có.
- Yêu cầu mới làm thay đổi architecture đã khóa.
- Có nhiều cách thiết kế nghiệp vụ khác nhau ảnh hưởng schema/API/UX về sau.
- Cần xóa/migrate dữ liệu hiện có.
- Repo hiện tại mâu thuẫn với sprint plan.
- Cần thêm dependency lớn chưa có trong master context.
- Cần thay đổi quy tắc scoring hoặc CSV schema mà người dùng chưa xác nhận.

Không hỏi những chi tiết implementation nhỏ; chọn giải pháp đơn giản nhất phù hợp contract hiện có.

## 6. Quy tắc git
- Không force push.
- Không xóa branch/commit.
- Không reset hard khi chưa được yêu cầu.
- Cuối sprint đề xuất commit message rõ ràng, ví dụ: `feat: complete sprint 04 markdown content and membership`.
- Chỉ push nếu người dùng yêu cầu hoặc workflow hiện tại đã cho phép rõ ràng.

## 7. Definition of Done chung
Một sprint chỉ được xem là xong khi:
- Chức năng trong scope chạy thật.
- Build thành công.
- Test liên quan pass.
- Docker/local stack nếu bị ảnh hưởng vẫn chạy.
- Không có secret bị commit.
- Không phá contract sprint trước.
- `PROJECT_STATE.md` và các contract liên quan đã cập nhật.
- AI báo cáo gọn: đã làm gì, file nào thay đổi, test gì đã chạy, còn blocker gì.

