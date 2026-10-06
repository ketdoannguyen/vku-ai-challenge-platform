"""Quyền đọc nội dung bên trong cuộc thi: thành viên đang hoạt động hoặc admin.

Nguồn duy nhất cho cả payload `access` của list/detail lẫn lỗi 401/403 của các route nội dung.
Đọc nội dung không dùng `content.visibility` cũ nữa: mọi tài liệu/Ảnh/BXH/lịch sử đều đi qua đây.
"""

from app.core.errors import api_error
from app.memberships.service import get_membership

# Lý do từ chối, cũng là giá trị `access.reason` trong payload list/detail.
LOGIN_REQUIRED = "login_required"
MEMBERSHIP_REQUIRED = "membership_required"
MEMBERSHIP_INACTIVE = "membership_inactive"


def read_access(membership: dict | None, account: dict | None) -> dict:
    """Trạng thái đọc từ account + membership đã có (không truy vấn DB).

    Thứ tự: chưa đăng nhập → login_required; admin → allowed (miễn membership ở mọi route đọc);
    membership đang hoạt động → allowed; đã từng tham gia nhưng bị vô hiệu hóa →
    membership_inactive; còn lại → membership_required. Membership thiếu `active` (dữ liệu cũ)
    coi như đang hoạt động, cùng quy ước với `public_membership`.
    """
    if account is None:
        return {"allowed": False, "reason": LOGIN_REQUIRED}
    if account.get("role") == "admin":
        return {"allowed": True, "reason": None}
    if membership is not None:
        if membership.get("active", True):
            return {"allowed": True, "reason": None}
        return {"allowed": False, "reason": MEMBERSHIP_INACTIVE}
    return {"allowed": False, "reason": MEMBERSHIP_REQUIRED}


async def require_read_access(
    db, competition: dict, account: dict | None
) -> dict | None:
    """Bắt buộc quyền đọc nội dung cuộc thi; trả membership (None khi admin xem trước) hoặc raise.

    Gọi TRƯỚC khi đọc Markdown/ảnh/lịch sử/BXH để người ngoài không nhận thông tin tồn tại.
    Admin miễn điều kiện membership ở mọi route đọc. Quyền sở hữu trên route dữ liệu của chính
    thí sinh (lịch sử, tải bài) là bộ lọc riêng theo `account_id`, không phải membership - không
    đổi vì luật này.
    """
    membership = (
        await get_membership(db, competition["_id"], account["_id"]) if account else None
    )
    access = read_access(membership, account)
    if access["allowed"]:
        return membership
    raise access_error(access["reason"])


def access_error(reason: str):
    """Lỗi tương ứng trạng thái bị từ chối đọc nội dung."""
    if reason == LOGIN_REQUIRED:
        return api_error(401, "UNAUTHORIZED", "Bạn cần đăng nhập để xem nội dung cuộc thi.")
    if reason == MEMBERSHIP_INACTIVE:
        return api_error(
            403, "MEMBERSHIP_INACTIVE", "Quyền tham gia cuộc thi đã bị vô hiệu hóa."
        )
    return api_error(403, "MEMBERSHIP_REQUIRED", "Bạn cần tham gia cuộc thi để xem nội dung này.")
