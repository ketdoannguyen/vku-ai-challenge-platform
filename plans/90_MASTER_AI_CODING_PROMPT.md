# Reusable Prompt - Run One Sprint With AI Coding Agent

Copy prompt bên dưới vào AI coding tool. Thay `<SPRINT_FILE>` bằng file sprint cần chạy.

---

Bạn đang phát triển repo **AI Challenge Platform**. Hãy hoàn thành CHÍNH XÁC MỘT sprint: `<SPRINT_FILE>`.

## Nguyên tắc bắt buộc
1. Trước khi code, đọc theo thứ tự:
   - `plans/00_README_FIRST.md`
   - `plans/01_MASTER_CONTEXT.md`
   - `plans/02_ARCHITECTURE_CONTRACTS.md`
   - `docs/PROJECT_STATE.md` nếu đã tồn tại; nếu Sprint 00 thì đọc `plans/03_PROJECT_STATE_TEMPLATE.md`
   - `docs/DECISIONS.md`, `docs/API_CONTRACT.md`, `docs/DATA_MODEL.md`, `docs/TEST_MATRIX.md` nếu đã tồn tại
   - `<SPRINT_FILE>`
2. Inspect repo thực tế, `git status`, cấu trúc file, dependencies và code hiện có. Không dựa vào trí nhớ chat để suy đoán state.
3. Trước khi sửa code, tóm tắt tối đa 10 bullet:
   - state hiện tại
   - prerequisite của sprint đã đạt/chưa
   - những file/module dự kiến bị ảnh hưởng
   - mâu thuẫn nếu có
4. Nếu có mâu thuẫn giữa repo và canonical docs, HOẶC cần một quyết định có ảnh hưởng schema/API/security/UX, DỪNG và hỏi tôi một câu hỏi ngắn, cụ thể. Không tự ý quyết định thay tôi.
5. Nếu không có blocker, thực hiện sprint đến acceptance criteria. KHÔNG tự làm sprint tiếp theo.

## Phong cách implementation
- Code ngắn gọn, clean, rõ ràng, dễ đọc, dễ debug.
- Ưu tiên giải pháp đơn giản nhất đáp ứng contract và acceptance criteria.
- Không over-engineering, không microservice hóa, không thêm layer/abstraction không cần thiết.
- Không duplicate logic. Tuy nhiên không tạo abstraction sớm chỉ để tránh vài dòng code trùng lặp nhỏ.
- Tên hàm/biến/route rõ nghĩa; function nhỏ và một trách nhiệm.
- Không để dead code, placeholder fake, TODO production-critical.
- Không refactor phần không liên quan sprint.
- Không thêm dependency lớn nếu standard library/dependency hiện có đủ dùng. Nếu thật sự cần dependency mới có ảnh hưởng lớn, hỏi tôi trước.
- Bảo toàn architecture: React/Vite/TypeScript + Nginx + FastAPI + MongoDB + Docker Compose + Cloudflare Tunnel trên 1 GCE VM.
- Không đưa Firebase/Redis/Celery/Kubernetes/queue vào MVP nếu tôi không yêu cầu.
- Giao diện clean, rõ ràng, responsive, ưu tiên desktop; không làm UI màu mè.
- Error message cho user phải dễ hiểu; server log hữu ích nhưng không log password/session/secret/ground truth.
- Mọi auth/permission/deadline/quota check quan trọng phải ở backend, không chỉ frontend.

## Cách làm việc
- Sửa nhỏ, chạy test sớm, không đợi đến cuối mới test.
- Nếu repo đã có pattern hợp lý, tiếp tục pattern đó thay vì tạo pattern mới.
- Nếu cần migration/index/bootstrap, tạo command/script idempotent hoặc hướng dẫn rõ.
- Nếu cần file `.env`, chỉ cập nhật `.env.example`; không tạo/commit production secret.
- README chỉ cập nhật các lệnh/thông tin người khác thực sự cần để chạy dự án.

## Validation bắt buộc trước khi kết thúc
Chạy những gì phù hợp với sprint, ví dụ:
- backend tests
- frontend typecheck/test/build
- Docker build/compose validation
- API smoke test
- security/path/upload checks liên quan

Nếu một test không thể chạy do thiếu credential/external infra, nói rõ CHÍNH XÁC test nào chưa chạy và vì sao; không ghi là pass.

## Handoff bắt buộc
Cuối sprint:
1. Cập nhật `docs/PROJECT_STATE.md`.
2. Cập nhật `docs/API_CONTRACT.md` nếu endpoint/request/response thay đổi.
3. Cập nhật `docs/DATA_MODEL.md` nếu collection/field/index thay đổi.
4. Cập nhật `docs/DECISIONS.md` nếu có quyết định mới.
5. Cập nhật `docs/TEST_MATRIX.md` theo test đã có.
6. Cập nhật README/DEPLOYMENT chỉ khi sprint làm thay đổi hướng dẫn chạy.
7. Đề xuất 1 commit message. Không push nếu tôi chưa yêu cầu.

## Báo cáo cuối sprint - ngắn gọn
Chỉ báo cáo:
- Completed
- Main files changed
- Tests/build actually run và kết quả
- Manual verification cần làm nếu có
- Known issues/blockers
- Next sprint file, NHƯNG KHÔNG BẮT ĐẦU sprint đó

Nếu cần bất kỳ input nào từ tôi, dừng ngay tại điểm cần input và hỏi cụ thể. Không đoán credential/domain/schema nghiệp vụ.

---

