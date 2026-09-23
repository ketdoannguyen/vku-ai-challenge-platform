"""AI Notebook Compliance Review - kiểm tra sơ bộ notebook bằng LLM, không có quyền quyết định.

Ba trục trạng thái độc lập: `submissions.status` (chấm điểm), `submissions.review` (BTC duyệt),
`submissions.ai_review` (AI sơ bộ). Module này chỉ được ghi vào trục thứ ba.
"""
