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
    data_dir: str = "./data"

    session_secret: str = ""
    session_lifetime_hours: int = 24
    session_cookie_name: str = "aic_session"
    session_cookie_secure: str = "auto"
    session_cookie_samesite: str = "lax"

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
