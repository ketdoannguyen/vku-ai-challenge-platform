#!/usr/bin/env bash
# Smoke MinIO thật cho artifact của submission.
#
# Dựng đúng hai service `minio` + `minio-init` của docker-compose.yml trong một Compose project
# CÔ LẬP (volume/network riêng, credential sinh tại chỗ) rồi kiểm chứng những tính chất mà ADR-028
# dựa vào. Chạy trước mỗi lượt rollout production và sau khi sửa compose/script init:
#
#   ./scripts/minio_smoke.sh
#
# Không cần .env của repo: credential truyền qua env file tạm và xoá khi xong. Script chỉ `down -v`
# ĐÚNG project cô lập của nó, không chạm stack dev/production.

set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT="${PROJECT:-vku-minio-smoke}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.yml}"
BUCKET="submission-artifacts"
KEY_PREFIX="competitions/smoke/accounts/smoke/submissions/smoke"

# Cùng tag với `minio-init` trong compose file: đổi tag ở compose là smoke đổi theo, không lệch.
MC_IMAGE="$(grep -oE 'quay\.io/minio/mc:[^[:space:]]+' "$COMPOSE_FILE" | head -n1)"
[ -n "$MC_IMAGE" ] || { echo "LỖI: không đọc được tag minio/mc từ $COMPOSE_FILE" >&2; exit 1; }

TMP_DIR="$(mktemp -d)"
ENV_FILE="$TMP_DIR/smoke.env"
PAYLOAD_DIR="$TMP_DIR/payload"
mkdir -p "$PAYLOAD_DIR"
chmod 700 "$TMP_DIR"

random_hex() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

# Credential dùng một lần: không đọc từ .env của repo và không in ra log.
cat >"$ENV_FILE" <<EOF
MINIO_ROOT_USER=smoke-root
MINIO_ROOT_PASSWORD=$(random_hex)
MINIO_ACCESS_KEY=smoke-app
MINIO_SECRET_KEY=$(random_hex)
MINIO_BUCKET=$BUCKET
EOF
chmod 600 "$ENV_FILE"

dc() { docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

cleanup() {
  dc down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

fail() { printf 'LỖI: %s\n' "$*" >&2; exit 1; }
pass() { printf 'OK  : %s\n' "$*"; }

# `mc` chạy trong container dùng chung network với MinIO. Credential vào container qua file mount
# (không qua argv) để không lộ trong `ps` của host.
mc_as() { # $1 = app|anon, còn lại là tham số mc
  local who="$1"
  shift
  docker run --rm --network "$PROJECT"_default \
    -v "$ENV_FILE:/smoke.env:ro" \
    -v "$PAYLOAD_DIR:/payload" \
    --entrypoint /bin/sh "$MC_IMAGE" -c '
      set -e
      . /smoke.env
      if [ "$1" = "app" ]; then
        export MC_HOST_target="http://$MINIO_ACCESS_KEY:$MINIO_SECRET_KEY@minio:9000"
      else
        export MC_HOST_target="http://minio:9000"
      fi
      shift
      mc --no-color "$@"
    ' mc "$who" "$@"
}

echo "== Dựng MinIO cô lập (project $PROJECT) =="
dc up -d --wait --wait-timeout 120 minio || fail "minio không healthy (healthcheck của image pin hỏng?)"
pass "minio healthy, healthcheck trong compose chạy được"

# Runtime check thay vì đọc config: container thật có publish port nào ra host không.
MINIO_CID="$(dc ps -q minio)"
[ -n "$MINIO_CID" ] || fail "không thấy container minio"
[ -z "$(docker port "$MINIO_CID")" ] || fail "MinIO đang publish port ra host: $(docker port "$MINIO_CID")"
pass "MinIO không publish port nào ra host"

echo "== minio-init =="
dc up --no-deps --force-recreate --exit-code-from minio-init minio-init ||
  fail "minio-init thất bại ở lần chạy đầu"
pass "minio-init chạy xong (bucket + app user + policy)"
dc up --no-deps --force-recreate --exit-code-from minio-init minio-init ||
  fail "minio-init không idempotent"
pass "minio-init chạy lại không lỗi"

echo "== Bucket private =="
ANON_OUT="$(mc_as anon ls "target/$BUCKET" 2>&1)" && fail "anonymous list được bucket: $ANON_OUT"
case "$ANON_OUT" in
  *"Access Denied"*) pass "anonymous bị từ chối: $(printf '%s' "$ANON_OUT" | tail -n1)" ;;
  *) fail "anonymous bị chặn nhưng không phải Access Denied: $ANON_OUT" ;;
esac

echo "== Round-trip hai artifact bằng credential app =="
printf 'id,prediction\n1,1\n2,0\n3,1\n' >"$PAYLOAD_DIR/prediction.csv"
cat >"$PAYLOAD_DIR/notebook.ipynb" <<'JSON'
{"cells":[{"cell_type":"code","execution_count":null,"metadata":{},"outputs":[],"source":["print(1)\n"]}],"metadata":{"kernelspec":{"display_name":"Python 3","language":"python","name":"python3"}},"nbformat":4,"nbformat_minor":5}
JSON

mc_as app cp "/payload/prediction.csv" "target/$BUCKET/$KEY_PREFIX/prediction.csv" >/dev/null
mc_as app cp "/payload/notebook.ipynb" "target/$BUCKET/$KEY_PREFIX/notebook.ipynb" >/dev/null
pass "app credential put được cả hai object"

# Object đã nằm trong bucket: kiểm luôn anonymous GET, không chỉ anonymous list.
ANON_GET="$(mc_as anon cat "target/$BUCKET/$KEY_PREFIX/prediction.csv" 2>&1)" &&
  fail "anonymous đọc được object: $ANON_GET"
pass "anonymous GET object bị từ chối"

mc_as app cp "target/$BUCKET/$KEY_PREFIX/prediction.csv" "/payload/prediction.out" >/dev/null
mc_as app cp "target/$BUCKET/$KEY_PREFIX/notebook.ipynb" "/payload/notebook.out" >/dev/null
cmp -s "$PAYLOAD_DIR/prediction.csv" "$PAYLOAD_DIR/prediction.out" || fail "prediction.csv đọc lại khác bytes gốc"
cmp -s "$PAYLOAD_DIR/notebook.ipynb" "$PAYLOAD_DIR/notebook.out" || fail "notebook.ipynb đọc lại khác bytes gốc"
pass "app credential get lại đúng bytes (sha256 $(sha256sum "$PAYLOAD_DIR/prediction.out" | cut -c1-12)…, $(sha256sum "$PAYLOAD_DIR/notebook.out" | cut -c1-12)…)"

echo "== Quyền ngoài phạm vi =="
mc_as app rm "target/$BUCKET/$KEY_PREFIX/prediction.csv" >/dev/null
mc_as app rm "target/$BUCKET/$KEY_PREFIX/notebook.ipynb" >/dev/null
REMAINING="$(mc_as app ls --recursive "target/$BUCKET" | wc -l)"
[ "$REMAINING" -eq 0 ] || fail "app credential delete không sạch, còn $REMAINING object"
pass "app credential delete được cả hai object"

printf '\nMinIO smoke PASS.\n'
