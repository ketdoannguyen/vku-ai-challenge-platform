from fastapi import HTTPException


def api_error(status_code: int, code: str, message: str) -> HTTPException:
    """Tạo HTTPException theo error format thống nhất của API_CONTRACT.md."""
    return HTTPException(status_code=status_code, detail={"code": code, "message": message})
