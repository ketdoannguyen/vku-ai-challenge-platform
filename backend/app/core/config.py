from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Config load từ environment; xem `.env.example` để biết meaning từng biến."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8")

    app_env: str = "development"
    app_name: str = "AI Challenge Platform"

    mongo_host: str = "localhost"
    mongo_port: int = 27017
    mongo_database: str = "ai_challenge"
    mongo_user: str = ""
    mongo_password: str = ""

    max_upload_mb: int = 10
    max_notebook_mb: int = 20
    max_content_mb: int = 2
    max_asset_mb: int = 2
    data_dir: str = "./data"

    # Artifact của submission (CSV dự đoán + notebook) nằm trong MinIO private; ground truth,
    # Markdown và assets vẫn ở `data_dir` (ADR-003 vẫn đúng cho các loại đó).
    minio_endpoint: str = "minio:9000"
    minio_access_key: str = ""
    minio_secret_key: str = ""
    minio_bucket: str = "submission-artifacts"
    minio_secure: bool = False

    session_secret: str = ""
    session_lifetime_hours: int = 24
    session_cookie_name: str = "aic_session"
    session_cookie_secure: str = "auto"
    session_cookie_samesite: str = "lax"

    # AI Notebook Review (ADR-036). Mọi giá trị đều có default để app vẫn boot khi tính năng chưa
    # được cấu hình: thiếu allowlist nghĩa là không bật được AI, không phải app hỏng.
    llm_config_encryption_key: str = ""
    ai_review_allowed_hosts: str = ""
    ai_review_allowed_private_hosts: str = ""
    ai_review_allowed_http_hosts: str = ""
    ai_review_allowed_ports: str = "443"
    ai_review_poll_interval_seconds: float = 5
    ai_review_reconcile_interval_seconds: int = 60
    ai_review_lease_seconds: int = 180
    ai_review_heartbeat_seconds: int = 45
    ai_review_max_attempts: int = 3
    ai_review_connect_timeout_seconds: float = 5
    ai_review_request_timeout_seconds: float = 60
    ai_review_max_response_bytes: int = 1_048_576
    # Trần snapshot luôn thấp an toàn so với giới hạn 16 MiB của một document Mongo.
    ai_review_max_snapshot_bytes: int = 8_388_608
    ai_review_max_policy_chars: int = 160_000
    ai_review_max_notebook_chars: int = 160_000
    ai_review_max_output_tokens: int = 2_500
    ai_review_reconcile_batch: int = 100
    # File worker ghi mỗi vòng lặp để healthcheck của container biết nó còn sống.
    ai_review_heartbeat_file: str = "/tmp/ai-review-worker.heartbeat"

    @property
    def ai_review_worker_config_valid(self) -> bool:
        """Heartbeat phải ngắn hơn lease, nếu không worker có thể mất job vào tay chính nó."""
        return 0 < self.ai_review_heartbeat_seconds < self.ai_review_lease_seconds

    @property
    def cookie_secure(self) -> bool:
        if self.session_cookie_secure == "auto":
            return self.is_production
        return self.session_cookie_secure == "true"

    @property
    def cookie_samesite(self) -> str:
        return "strict" if self.session_cookie_samesite == "strict" else "lax"

    @property
    def is_production(self) -> bool:
        return self.app_env == "production"

    @property
    def mongo_uri(self) -> str:
        if self.mongo_user and self.mongo_password:
            return (
                f"mongodb://{self.mongo_user}:{self.mongo_password}"
                f"@{self.mongo_host}:{self.mongo_port}/{self.mongo_database}"
                "?authSource=admin"
            )
        return f"mongodb://{self.mongo_host}:{self.mongo_port}/{self.mongo_database}"


@lru_cache
def get_settings() -> Settings:
    return Settings()
