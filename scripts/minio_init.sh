#!/usr/bin/env bash
# Bootstrap MinIO cho artifact của submission (prediction CSV + notebook): bucket private và một
# application user least-privilege. Chạy như service one-shot `minio-init` ở cả dev và prod, hoặc chạy
# tay khi cần bootstrap trước lượt deploy đầu:
#
#   sudo docker compose --env-file /srv/vku-ai-challenge/.env \
#     -f docker-compose.prod.yml up -d minio minio-init
#
# Idempotent và luôn ép lại trạng thái theo env: chạy lại đưa bucket/user/policy về đúng như khai báo,
# kể cả khi vừa đổi MINIO_SECRET_KEY - nên đây cũng là cách xoay credential của app.
#
# KHÔNG log credential và KHÔNG `set -x`: giá trị nội suy sẽ lọt nguyên vào log của `docker compose`.

set -euo pipefail

MINIO_ENDPOINT="${MINIO_ENDPOINT:?MINIO_ENDPOINT bắt buộc có trong env}"
MINIO_ROOT_USER="${MINIO_ROOT_USER:?MINIO_ROOT_USER bắt buộc có trong env}"
MINIO_ROOT_PASSWORD="${MINIO_ROOT_PASSWORD:?MINIO_ROOT_PASSWORD bắt buộc có trong env}"
MINIO_ACCESS_KEY="${MINIO_ACCESS_KEY:?MINIO_ACCESS_KEY bắt buộc có trong env}"
MINIO_SECRET_KEY="${MINIO_SECRET_KEY:?MINIO_SECRET_KEY bắt buộc có trong env}"
MINIO_BUCKET="${MINIO_BUCKET:-submission-artifacts}"
MINIO_POLICY_NAME="${MINIO_POLICY_NAME:-submission-artifacts-app}"
MINIO_READY_ATTEMPTS="${MINIO_READY_ATTEMPTS:-30}"

log() { printf '%s [minio-init] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "LỖI: $*" >&2; exit 1; }

command -v mc >/dev/null 2>&1 || die "không thấy mc trong PATH"

# Alias chỉ sống trong container này; credential root không rời khỏi đây.
mc alias set local "$MINIO_ENDPOINT" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null

for attempt in $(seq 1 "$MINIO_READY_ATTEMPTS"); do
  mc ready local >/dev/null 2>&1 && break
  [ "$attempt" -lt "$MINIO_READY_ATTEMPTS" ] ||
    die "MinIO không sẵn sàng tại $MINIO_ENDPOINT sau $MINIO_READY_ATTEMPTS lần thử"
  sleep 2
done
log "MinIO sẵn sàng tại $MINIO_ENDPOINT"

mc mb --ignore-existing "local/$MINIO_BUCKET" >/dev/null
# Bucket phải private: mọi lượt upload/download đi qua FastAPI để enforce quota và authorization,
# không có presigned URL và không route Nginx nào tới MinIO (ADR-028).
mc anonymous set none "local/$MINIO_BUCKET" >/dev/null

POLICY_FILE="$(mktemp)"
trap 'rm -f "$POLICY_FILE"' EXIT
# Chỉ đúng bucket này, chỉ đúng quyền app dùng: liệt kê bucket + get/put/delete object.
cat >"$POLICY_FILE" <<JSON
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:GetBucketLocation", "s3:ListBucket"],
      "Resource": ["arn:aws:s3:::$MINIO_BUCKET"]
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": ["arn:aws:s3:::$MINIO_BUCKET/*"]
    }
  ]
}
JSON

# Xoá rồi tạo lại thay vì "tạo nếu chưa có": policy đổi nội dung mà bị bỏ qua thì bucket giữ quyền cũ,
# và điều đó không nhìn ra được từ ngoài.
mc admin policy remove local "$MINIO_POLICY_NAME" >/dev/null 2>&1 || true
mc admin policy create local "$MINIO_POLICY_NAME" "$POLICY_FILE" >/dev/null

# Cùng lý do với policy: xoá rồi tạo lại để MINIO_SECRET_KEY mới trong env thật sự có hiệu lực.
mc admin user remove local "$MINIO_ACCESS_KEY" >/dev/null 2>&1 || true
mc admin user add local "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY" >/dev/null
mc admin policy attach local "$MINIO_POLICY_NAME" --user "$MINIO_ACCESS_KEY" >/dev/null

mc admin user info local "$MINIO_ACCESS_KEY" >/dev/null || die "app user không tồn tại sau khi tạo"
log "Xong: bucket $MINIO_BUCKET private, policy $MINIO_POLICY_NAME đã gắn cho app user."
