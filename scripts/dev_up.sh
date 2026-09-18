#!/usr/bin/env bash
# Setup + smoke test local stack cho test thủ công (Sprint 01-02).
#
# Script này làm toàn bộ thay vì gõ tay từng lệnh:
#   1. Tạo .env từ .env.example nếu chưa có (ghi đè MONGO_USER/MONGO_PASSWORD random)
#   2. docker compose up --build -d (qua sudo nếu user chưa có group docker)
#   3. Chờ api healthy
#   4. Tạo admin + 2 participant mẫu (idempotent - chạy lại không lỗi duplicate)
#   5. Smoke test: health + login (cookie jar) + /auth/me đúng admin + admin API qua Nginx
#   6. In thông tin đăng nhập để test UI tại http://localhost:8080
#
# Cách dùng: ./scripts/dev_up.sh [--down] [--clean]
#   (không tham số)  : up + seed + smoke test
#   --down           : dừng stack, giữ volume (giữ account đã tạo)
#   --clean          : dừng stack + xóa volume (xóa sạch data, chạy seed lại từ đầu)

set -euo pipefail
cd "$(dirname "$0")/.."

ADMIN_EMAIL="${ADMIN_EMAIL:-admin@vku.vn}"
ADMIN_NAME="${ADMIN_NAME:-Admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-1}"
PART1_EMAIL="${PART1_EMAIL:-team1@vku.vn}"
PART1_PASSWORD="${PART1_PASSWORD:-1}"
PART2_EMAIL="${PART2_EMAIL:-team2@vku.vn}"
PART2_PASSWORD="${PART2_PASSWORD:-1}"
WEB_PORT="${WEB_PORT:-8080}"
BASE_URL="http://localhost:${WEB_PORT}"

log()  { printf '\033[1;32m[dev_up]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[dev_up]\033[0m LỖI: %s\n' "$*" >&2; exit 1; }

# ---------- docker: tự dùng sudo nếu cần (tránh lỗi permission mỗi lần chạy) ----------
if docker info >/dev/null 2>&1; then
  DOCKER="docker"
else
  log "User chưa có quyền docker - dùng 'sudo docker' (cần nhập password sudo 1 lần)."
  log "Để khỏi bị hỏi nữa: sudo usermod -aG docker nkd && đăng xuất/login lại."
  DOCKER="sudo docker"
fi

ARG="${1:-}"

if [[ "$ARG" == "--down" ]]; then
  log "Dừng stack (giữ volume)..."
  $DOCKER compose down
  log "Xong. Chạy lại ./scripts/dev_up.sh để khởi động."
  exit 0
fi

if [[ "$ARG" == "--clean" ]]; then
  log "Dừng stack + XÓA volume (mọi account/data biến mất)..."
  $DOCKER compose down -v
  log "Xong."
  exit 0
fi

# ---------- 1. .env ----------
if [[ ! -f .env ]]; then
  log "Tạo .env từ .env.example (MONGO password random)..."
  RAND_PASS="$(head -c 24 /dev/urandom | base64 | tr -d '/+=')"
  sed "s/^MONGO_USER=.*/MONGO_USER=aic_local/; s/^MONGO_PASSWORD=.*/MONGO_PASSWORD=${RAND_PASS}/" .env.example > .env
fi

# ---------- 2. compose up ----------
log "docker compose up --build -d..."
$DOCKER compose up --build -d

# ---------- 3. chờ api healthy qua Nginx ----------
log "Chờ /api/health trả 200 (tối đa 60s)..."
HEALTH_OK=""
for _ in $(seq 1 30); do
  STATUS="$(curl -s -o /dev/null -w '%{http_code}' "$BASE_URL/api/health" || true)"
  if [[ "$STATUS" == "200" ]]; then HEALTH_OK="1"; break; fi
  sleep 2
done
[[ -n "$HEALTH_OK" ]] || fail "api không healthy sau 60s - xem log: $DOCKER compose logs api"
log "Health: $(curl -s "$BASE_URL/api/health")"

# ---------- 4. seed accounts (chạy trong container api - không cần venv host) ----------
seed() { # email name password role
  $DOCKER compose exec -T api python - "$1" "$2" "$3" "$4" <<'PYEOF'
import sys
sys.path.insert(0, ".")
import asyncio
from app.accounts.service import AccountCreate, create_account, ensure_indexes, find_account_by_email
from app.core.database import MongoContext
from app.main import app  # noqa: F401 - chỉ để lifespan path được import đúng

async def main(email, name, password, role):
    from motor.motor_asyncio import AsyncIOMotorClient
    from app.core.config import get_settings
    s = get_settings()
    client = AsyncIOMotorClient(s.mongo_uri, serverSelectionTimeoutMS=5000)
    db = client[s.mongo_database]
    try:
        await ensure_indexes(db)
        if await find_account_by_email(db, email) is not None:
            print(f"EXISTS:{email}")
            return
        await create_account(db, AccountCreate(email=email, name=name, password=password, role=role))
        print(f"CREATED:{email}")
    finally:
        client.close()

asyncio.run(main(*sys.argv[1:]))
PYEOF
}

log "Seed accounts (idempotent)..."
for entry in "$ADMIN_EMAIL|$ADMIN_NAME|$ADMIN_PASSWORD|admin" \
             "$PART1_EMAIL|Đội 01|$PART1_PASSWORD|participant" \
             "$PART2_EMAIL|Đội 02|$PART2_PASSWORD|participant"; do
  IFS='|' read -r email name password role <<< "$entry"
  RESULT="$(seed "$email" "$name" "$password" "$role")"
  log "  $RESULT"
done

# ---------- 5. smoke test qua Nginx ----------
log "Smoke test..."
SMOKE_FAIL=""
COOKIE_JAR="$(mktemp)"
LOGIN_BODY="$(mktemp)"
ME_BODY="$(mktemp)"
ACCOUNTS_BODY="$(mktemp)"
WRONG_BODY="$(mktemp)"
trap 'rm -f "$COOKIE_JAR" "$LOGIN_BODY" "$ME_BODY" "$ACCOUNTS_BODY" "$WRONG_BODY"' EXIT

# Đọc một field JSON từ stdin bằng python của container api - host không cần jq.
json_field() { # $1 = tên field
  $DOCKER compose exec -T api python -c \
    'import json,sys; print(json.load(sys.stdin).get(sys.argv[1], ""))' "$1"
}

# login đúng: `-c` ghi cookie jar, đây là thứ chứng minh session thật dùng được ở các bước sau.
LOGIN_CODE="$(curl -s -o "$LOGIN_BODY" -w '%{http_code}' -c "$COOKIE_JAR" -X POST "$BASE_URL/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"identifier\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")"
[[ "$LOGIN_CODE" == "200" ]] || SMOKE_FAIL="login đúng trả $LOGIN_CODE: $(cat "$LOGIN_BODY")"

# /auth/me phải 200 bằng chính cookie jar đó - nếu cookie không được ghi/đọc thì fail tại đây.
ME_CODE="$(curl -s -o "$ME_BODY" -w '%{http_code}' -b "$COOKIE_JAR" -c "$COOKIE_JAR" "$BASE_URL/api/auth/me")"
[[ "$ME_CODE" == "200" ]] || SMOKE_FAIL="${SMOKE_FAIL:+$SMOKE_FAIL; }/auth/me trả $ME_CODE (kỳ vọng 200)"
ME_ROLE="$(json_field role < "$ME_BODY" 2>/dev/null || true)"
[[ "$ME_ROLE" == "admin" ]] || SMOKE_FAIL="${SMOKE_FAIL:+$SMOKE_FAIL; }/auth/me role='$ME_ROLE' (kỳ vọng admin)"

# Một endpoint admin thật sự: 200 nghĩa là session + phân quyền đi qua được Nginx.
ACCOUNTS_CODE="$(curl -s -o "$ACCOUNTS_BODY" -w '%{http_code}' -b "$COOKIE_JAR" "$BASE_URL/api/admin/accounts?limit=1")"
[[ "$ACCOUNTS_CODE" == "200" ]] || SMOKE_FAIL="${SMOKE_FAIL:+$SMOKE_FAIL; }admin accounts trả $ACCOUNTS_CODE (kỳ vọng 200)"

# Login sai → 401 generic, không tiết lộ email có tồn tại hay không.
# Đặt sau lần login thành công vì login đúng reset bộ đếm failed-login.
WRONG_CODE="$(curl -s -o "$WRONG_BODY" -w '%{http_code}' -X POST "$BASE_URL/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"identifier\":\"$ADMIN_EMAIL\",\"password\":\"sai-roi\"}")"
[[ "$WRONG_CODE" == "401" ]] || SMOKE_FAIL="${SMOKE_FAIL:+$SMOKE_FAIL; }login sai trả $WRONG_CODE (kỳ vọng 401)"
grep -q 'Email hoặc mật khẩu không đúng' "$WRONG_BODY" || SMOKE_FAIL="${SMOKE_FAIL:+$SMOKE_FAIL; }login sai không trả message generic"

[[ -z "$SMOKE_FAIL" ]] || fail "smoke test: $SMOKE_FAIL"
log "Smoke test PASS: login 200, /auth/me role=admin, /admin/accounts 200, login sai 401 generic."

# ---------- 6. thông tin test UI ----------
cat <<EOF

=====================================================
 Stack đã sẵn sàng: $BASE_URL

 Tài khoản test:
   Admin      : $ADMIN_EMAIL / $ADMIN_PASSWORD
   Participant: $PART1_EMAIL / $PART1_PASSWORD
   Participant: $PART2_EMAIL / $PART2_PASSWORD

 Test UI:
   1. $BASE_URL/login  → đăng nhập admin → vào /admin/accounts
   2. Đăng nhập participant → KHÔNG thấy nav Quản trị, vào /admin/accounts bị redirect
   3. /api/health trả {"status":"ok","mongo":"reachable"}

 Lệnh hữu ích:
   ./scripts/dev_up.sh --down    # dừng, giữ account
   ./scripts/dev_up.sh --clean   # xóa sạch data (volume)
   $DOCKER compose logs -f api   # xem log backend
=====================================================
EOF
