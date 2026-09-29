from fastapi import HTTPException


def api_error(
    status_code: int, code: str, message: str, *, detail: str | None = None
) -> HTTPException:
    """Tạo HTTPException theo error format thống nhất của API_CONTRACT.md.

    `detail` chỉ dành cho endpoint admin (ví dụ stderr của bộ chấm khi chạy thử): luồng thí sinh
    không bao giờ truyền vào, vì chi tiết lỗi có thể chứa đáp án.
    """
    payload = {"code": code, "message": message}
    if detail:
        payload["detail"] = detail
    return HTTPException(status_code=status_code, detail=payload)
