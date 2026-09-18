#!/usr/bin/env bash
# Backup stack production: mongodump (nén) + archive thư mục dữ liệu app.
#
#   sudo /srv/vku-ai-challenge/repo/scripts/backup_prod.sh
#
# Mỗi lần chạy tạo một thư mục timestamp trong $BACKUP_DIR chứa:
#   mongo.archive.gz  — toàn bộ database (mongodump --archive --gzip)
#   app-data.tar.gz   — thư mục upload của app ($DATA_DIR/app)
#   MANIFEST.txt      — kích thước và sha256 để đối chiếu lại sau
#
# Chỉ áp dụng retention SAU KHI backup mới đã tạo xong và qua kiểm tra.
# CẢNH BÁO: backup nằm cùng boot disk với dữ liệu — chỉ cứu được lỗi thao tác,
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
flock -n 9 || { log "Đã có tiến trình backup khác đang chạy — bỏ qua lần này."; exit 0; }

TS="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BACKUP_DIR/$TS"
mkdir -p "$DEST"
log "Bắt đầu backup vào $DEST"

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

du -sh "$DEST"/* >"$DEST/MANIFEST.txt"
sha256sum "$DEST"/*.gz >>"$DEST/MANIFEST.txt"

find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '20*' -mtime "+$RETENTION_DAYS" -exec rm -rf {} +
log "Hoàn tất: $DEST (giữ ${RETENTION_DAYS} ngày)"
