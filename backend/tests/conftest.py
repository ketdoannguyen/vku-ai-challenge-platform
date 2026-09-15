import sys
from pathlib import Path

# Cho pytest tìm thấy package `app` khi chạy từ repo root hoặc backend/
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
