# Sprint Map - From Empty Repo to Production

## Tổng quan

| Sprint | Chủ đề | Đầu ra chính | Phụ thuộc |
|---|---|---|---|
| 00 | Project guardrails & bootstrap | Repo skeleton, canonical docs, env baseline | None |
| 01 | Local Docker stack & app shell | React + FastAPI + Mongo + Nginx chạy local | 00 |
| 02 | Auth & accounts | Login/session, admin account management | 01 |
| 03 | Competition core | Multi-competition lifecycle + admin CRUD | 02 |
| 04 | Markdown & membership | Dynamic content + join policies | 03 |
| 05 | Submission & scoring | CSV upload/validate + F1/Precision/Recall | 04 |
| 06 | Results | My Submissions + leaderboard + Excel export | 05 |
| 07 | Hardening & release candidate | Admin completion, security, UX, tests | 06 |
| 08 | Production deploy | GCE VM + Docker + Cloudflare Tunnel + domain | 07 |
| 09 | Pilot & operations | Backup/restore, pilot, runbook, final handover | 08 |

## Dependency rule
Không skip sprint nếu chưa có acceptance của sprint trước, trừ khi người dùng chủ động thay đổi thứ tự.

## Functional dependency chain

    Repo/contracts
      -> local runtime
      -> identity/session
      -> competitions
      -> membership/content
      -> submissions/scoring
      -> leaderboard/export
      -> hardening
      -> production
      -> operations

## Context handoff chain
Mỗi sprint:

    READ actual repo
      + docs/PROJECT_STATE.md
      + docs/DECISIONS.md
      + API/DATA contracts
      + current sprint plan
        -> IMPLEMENT
        -> TEST
        -> UPDATE canonical docs
        -> STOP

## What is intentionally deferred after MVP
- Public/private leaderboard split.
- Multiple scoring task types beyond classification CSV.
- Async scoring queue.
- Object storage.
- Email notification.
- Self-registration.
- Team member sub-accounts.
- Discussion/forum.
- SSO/OAuth.
- High availability/multi-VM.

Chỉ đưa các mục này vào roadmap sau khi MVP production ổn định.

