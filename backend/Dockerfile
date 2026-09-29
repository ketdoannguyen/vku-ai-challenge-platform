FROM python:3.12-slim AS api

WORKDIR /app

COPY pyproject.toml ./
RUN pip install --no-cache-dir .

COPY app ./app

# Script vận hành (create_admin) chạy bằng `docker compose exec api python scripts/...`
COPY scripts ./scripts

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]

# Runner chấm điểm (ADR-048): cùng code với API, khác duy nhất ở chỗ có docker CLI. Đây là tiến trình
# DUY NHẤT trong hệ thống được mount docker socket, và nó chỉ dùng socket để mở container con - code
# chấm của admin không bao giờ chạy trong tiến trình này.
FROM api AS runner

ARG TARGETARCH
ARG DOCKER_CLI_VERSION=27.5.1
# Chỉ lấy docker CLI, không lấy daemon: runner cần đúng khả năng mở container.
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) arch=x86_64 ;; \
      arm64) arch=aarch64 ;; \
      *) echo "Kiến trúc không hỗ trợ: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    apt-get update; \
    apt-get install -y --no-install-recommends curl ca-certificates; \
    curl -fsSL "https://download.docker.com/linux/static/stable/${arch}/docker-${DOCKER_CLI_VERSION}.tgz" \
      | tar -xz -C /usr/local/bin --strip-components=1 docker/docker; \
    apt-get purge -y curl; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/*; \
    docker --version

EXPOSE 8100
CMD ["python", "-m", "app.evaluator_runner.server"]
