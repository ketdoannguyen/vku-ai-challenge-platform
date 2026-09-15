# PROJECT_STATE Template

Sprint 00 phải tạo `docs/PROJECT_STATE.md` từ template này và cập nhật cuối mỗi sprint.

---

# AI Challenge Platform - Current Project State

## 1. Current checkpoint
- Last completed sprint: SPRINT_XX
- Date:
- Branch:
- Commit/working tree status:
- Overall state: green | yellow | blocked

## 2. Implemented capabilities
- ...

## 3. Not implemented yet
- ...

## 4. Repository structure that matters
- `path`: purpose

## 5. Runtime/services
- web:
- api:
- mongo:
- cloudflared:

## 6. Current API contract summary
### Auth
- ...
### Competitions
- ...
### Content
- ...
### Submission/leaderboard
- ...
### Admin
- ...

Full source of truth: `docs/API_CONTRACT.md`.

## 7. Current data model and indexes
- ...

Full source of truth: `docs/DATA_MODEL.md`.

## 8. Environment variables in use
- VARIABLE: purpose, secret? yes/no

Do NOT put real secret values here.

## 9. Commands verified
### Local startup
    ...
### Tests
    ...
### Build
    ...

## 10. Tests currently passing
- backend:
- frontend:
- integration/smoke:

## 11. Known issues / technical debt
- ...

## 12. Decisions made this sprint
- ADR/decision reference:

## 13. Preconditions for next sprint
- ...

## 14. Exact next sprint
- `plans/sprints/SPRINT_XX_....md`

## 15. Handoff notes for the next AI agent
- 5-15 bullet chỉ chứa các sự thật cần để tiếp tục.

---

Rules:
- Không ghi suy đoán.
- Không ghi secret.
- Nếu một chức năng đang partial, nói rõ partial ở đâu.
- Mỗi endpoint/schema đã thay đổi phải đồng bộ sang contract file.

