#!/usr/bin/env bash
# Backup stack production: mongodump (nén) + archive thư mục dữ liệu app + mirror bucket MinIO.
#
#   sudo /srv/vku-ai-challenge/repo/scripts/backup_prod.sh
#
# Mỗi lần chạy tạo một thư mục timestamp trong $BACKUP_DIR chứa:
#   mongo.archive.gz        - toàn bộ database (mongodump --archive --gzip)
#   app-data.tar.gz         - thư mục upload của app ($DATA_DIR/app)
#   minio-artifacts.tar.gz  - mirror bucket artifact của submission (ADR-028)
#   MANIFEST.txt            - kích thước và sha256 để đối chiếu lại sau
#
# Chỉ áp dụng retention SAU KHI backup mới đã tạo xong và qua kiểm tra. MinIO là phần bắt buộc:
# thiếu nó thì bản backup thiếu hẳn CSV/notebook của mọi submission, nên lần chạy dừng lại và thư
# mục dở dang bị xoá thay vì để lại một bản backup trông như đã hoàn tất.
# CẢNH BÁO: backup nằm cùng boot disk với dữ liệu - chỉ cứu được lỗi thao tác,
# KHÔNG cứu được khi mất disk/VM. Cần snapshot GCE hoặc bản sao ngoài máy.

set -euo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-/srv/vku-ai-challenge/repo/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-/srv/vku-ai-challenge/.env}"
DATA_DIR="${DATA_DIR:-/srv/vku-ai-challenge/data}"
BACKUP_DIR="${BACKUP_DIR:-/srv/vku-ai-challenge/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "LỖI: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "phải chạy bằng sudo (Docker cần quyền root)"
command -v docker >/dev/null 2>&1 || die "không thấy docker trong PATH"
[[ -f "$COMPOSE_FILE" ]] || die "không thấy compose file: $COMPOSE_FILE"
[[ -f "$ENV_FILE" ]] || die "không thấy env file: $ENV_FILE"
[[ -d "$DATA_DIR/app" ]] || die "không thấy thư mục dữ liệu app: $DATA_DIR/app"

dc() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# Khóa chống chạy chồng lấn (timer trùng với một lần chạy tay).
exec 9>"$BACKUP_DIR/.lock"
flock -n 9 || { log "Đã có tiến trình backup khác đang chạy - bỏ qua lần này."; exit 0; }

TS="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BACKUP_DIR/$TS"
mkdir -p "$DEST"
log "Bắt đầu backup vào $DEST"

MINIO_ENV_FILE="$(mktemp)"
complete=0
cleanup() {
  rm -f "$MINIO_ENV_FILE"
  if [[ "$complete" -ne 1 ]]; then
    rm -rf "$DEST"
    log "Backup dở dang - đã xoá $DEST (không để lại bản backup thiếu dữ liệu)"
  fi
}
trap cleanup EXIT

dc exec -T mongo sh -c 'mongodump --host 127.0.0.1 --port 27017 \
    --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" \
    --authenticationDatabase admin --db "$MONGO_INITDB_DATABASE" \
    --archive --gzip' >"$DEST/mongo.archive.gz" || die "mongodump thất bại"

gzip -t "$DEST/mongo.archive.gz" || die "archive Mongo hỏng (gzip -t thất bại)"

# Kiểm tra thật: dry-run đọc lại archive và báo lỗi nếu không parse được.
# (đã kiểm chứng: archive hỏng trả exit 1, archive hợp lệ trả exit 0)
dc exec -T mongo sh -c 'mongorestore --host 127.0.0.1 --port 27017 \
    --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" \
    --authenticationDatabase admin --archive --gzip --dryRun' \
    <"$DEST/mongo.archive.gz" >/dev/null || die "archive Mongo không đọc lại được (dry-run thất bại)"

tar -czf "$DEST/app-data.tar.gz" -C "$DATA_DIR" app || die "nén thư mục dữ liệu app thất bại"
gzip -t "$DEST/app-data.tar.gz" || die "archive app hỏng"
tar -tzf "$DEST/app-data.tar.gz" >/dev/null || die "không liệt kê được archive app"

# --- MinIO: mirror toàn bộ bucket artifact (ADR-028) ---
# Dùng đúng tag `mc` mà compose pin cho minio-init, để lệnh backup không lệch khỏi hạ tầng đang chạy.
MC_IMAGE="$(grep -oE 'quay\.io/minio/mc:[^[:space:]]+' "$COMPOSE_FILE" | head -n1)"
[[ -n "$MC_IMAGE" ]] || die "không đọc được tag minio/mc từ $COMPOSE_FILE"

MINIO_CID="$(dc ps -q minio)"
[[ -n "$MINIO_CID" ]] || die "không thấy container minio - dừng lại thay vì tạo bản backup thiếu artifact"
# Lấy network thật của MinIO thay vì hardcode tên project: container mc dùng một lần chỉ cần
# nhìn thấy `minio:9000` qua DNS nội bộ của Docker.
NETWORK="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' \
  "$MINIO_CID" | head -n1)"
[[ -n "$NETWORK" ]] || die "không xác định được Docker network của MinIO"

env_value() { sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$ENV_FILE" | tail -n1; }
MINIO_ACCESS_KEY="$(env_value MINIO_ACCESS_KEY)"
MINIO_SECRET_KEY="$(env_value MINIO_SECRET_KEY)"
MINIO_BUCKET="$(env_value MINIO_BUCKET)"
MINIO_BUCKET="${MINIO_BUCKET:-submission-artifacts}"
[[ -n "$MINIO_ACCESS_KEY" && -n "$MINIO_SECRET_KEY" ]] ||
  die "thiếu MINIO_ACCESS_KEY/MINIO_SECRET_KEY trong $ENV_FILE"

# Credential đi vào container qua --env-file tạm (không vào argv nên không hiện trong `ps`), và
# KHÔNG mount cả .env production vào container dùng một lần này. File tạm bị xoá ở trap EXIT.
chmod 600 "$MINIO_ENV_FILE"
{
  printf 'MINIO_ACCESS_KEY=%s\n' "$MINIO_ACCESS_KEY"
  printf 'MINIO_SECRET_KEY=%s\n' "$MINIO_SECRET_KEY"
  printf 'MINIO_BUCKET=%s\n' "$MINIO_BUCKET"
} >"$MINIO_ENV_FILE"
unset MINIO_ACCESS_KEY MINIO_SECRET_KEY

docker run --rm --network "$NETWORK" --env-file "$MINIO_ENV_FILE" -v "$DEST:/backup" \
  --entrypoint /bin/sh "$MC_IMAGE" -c '
    set -e
    export MC_HOST_artifacts="http://$MINIO_ACCESS_KEY:$MINIO_SECRET_KEY@minio:9000"
    mc --no-color mirror "artifacts/$MINIO_BUCKET" /backup/minio-artifacts
  ' || die "mirror bucket $MINIO_BUCKET thất bại"
rm -f "$MINIO_ENV_FILE"

tar -czf "$DEST/minio-artifacts.tar.gz" -C "$DEST" minio-artifacts || die "nén mirror MinIO thất bại"
gzip -t "$DEST/minio-artifacts.tar.gz" || die "archive MinIO hỏng"
tar -tzf "$DEST/minio-artifacts.tar.gz" >/dev/null || die "không liệt kê được archive MinIO"
# Bỏ bản mirror thô để MANIFEST chỉ liệt kê các archive, không đếm trùng dữ liệu hai lần.
rm -rf "$DEST/minio-artifacts"

du -sh "$DEST"/* >"$DEST/MANIFEST.txt"
sha256sum "$DEST"/*.gz >>"$DEST/MANIFEST.txt"
complete=1

find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '20*' -mtime "+$RETENTION_DAYS" -exec rm -rf {} +
log "Hoàn tất: $DEST (giữ ${RETENTION_DAYS} ngày)"
