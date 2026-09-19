#!/usr/bin/env bash
# Harness cho scripts/backup_prod.sh: chạy script backup thật trên cây thư mục tạm với `docker` giả.
#
#   bash deploy/vps/tests/backup-prod.test.sh
#
# Không cần Docker, không cần mạng, không cần root. `gzip`/`tar`/`flock` là thật vì đó chính là phần
# sinh ra và kiểm tra archive; `docker` là giả vì phần đó chỉ có nghĩa trên VM production.
#
# Harness cố ý KHÔNG dùng `set -e`: một case hỏng phải được đếm rồi đi tiếp, không dừng cả bộ test.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/backup_prod.sh"

PASSED=0
FAILED=0
ROOT=""
OUT=""
STATUS=0
DEST=""

ok() { PASSED=$((PASSED + 1)); printf '  ok   %s\n' "$1"; }
no() { FAILED=$((FAILED + 1)); printf '  FAIL %s\n' "$1"; }
begin() { printf '\n== %s\n' "$1"; }

expect_status() {
  if [ "$STATUS" -eq "$2" ]; then ok "$1 (exit $STATUS)"; else no "$1 (exit $STATUS, mong đợi $2)"; fi
}
expect_in() {
  case "$2" in *"$3"*) ok "$1" ;; *) no "$1 - không thấy '$3' trong output: $2" ;; esac
}
expect_exists() {
  if [ -e "$2" ]; then ok "$1"; else no "$1 - không thấy $2"; fi
}
expect_missing() {
  if [ -e "$2" ]; then no "$1 - vẫn còn $2"; else ok "$1"; fi
}
expect_eq() {
  if [ "$2" = "$3" ]; then ok "$1"; else no "$1 - nhận '$2', mong đợi '$3'"; fi
}

# Số thư mục backup (mỗi lượt chạy tạo đúng một thư mục timestamp).
backup_dirs() { find "$ROOT/backups" -mindepth 1 -maxdepth 1 -type d -name '20*' | sort; }
backup_dir_count() { backup_dirs | wc -l | tr -d ' '; }

# Bất biến thật của script: KHÔNG bao giờ để lại thư mục backup thiếu MANIFEST.txt. Đếm thư mục là
# cách kiểm yếu hơn: `TS` chỉ có độ phân giải giây nên hai lượt liền nhau trong cùng một giây dùng
# chung tên thư mục, và phép đếm sẽ báo sai lệch dù bất biến vẫn đúng.
partial_dirs() {
  local d
  for d in $(backup_dirs); do
    [ -f "$d/MANIFEST.txt" ] || printf '%s\n' "$d"
  done
}
partial_count() { partial_dirs | wc -l | tr -d ' '; }

# Thư mục backup quá hạn, đủ nội dung để không bị tính là bản dở dang.
make_old_backup() {
  mkdir -p "$1"
  printf 'bản cũ\n' >"$1/MANIFEST.txt"
  touch -d '2020-01-01' "$1"
}
manifest_hashes() { grep -cE '^[0-9a-f]{64}  ' "$1/MANIFEST.txt"; }

# ---------------------------------------------------------------- docker giả
install_fake_docker() {
  cat >"$ROOT/bin/docker" <<'FAKE'
#!/usr/bin/env bash
# Docker giả: chỉ mô phỏng đúng những lời gọi mà backup_prod.sh dùng.
set -uo pipefail
printf '%s\n' "$*" >>"$FAKE_DOCKER_LOG"
cmd="${1:-}"; shift || true

case "$cmd" in
  compose)
    while [ $# -gt 0 ]; do
      case "$1" in --env-file|-f) shift 2 ;; *) break ;; esac
    done
    sub="${1:-}"; shift || true
    case "$sub" in
      ps)
        if [ "${1:-}" = "-q" ] && [ "${2:-}" = "minio" ]; then
          [ "${FAKE_NO_MINIO:-0}" = "1" ] || echo "minio-ctr"
        fi
        exit 0
        ;;
      exec)
        while [ $# -gt 0 ]; do case "$1" in -T) shift ;; *) break ;; esac; done
        case "$*" in
          *mongodump*)
            # Giữ lượt chạy đứng yên giữa đường để harness ngắt/khoá chồng lấn một cách xác định.
            if [ "${FAKE_HOLD_DUMP:-0}" = "1" ]; then
              while [ -e "$FAKE_HOLD_FILE" ]; do sleep 0.1; done
            fi
            if [ "${FAKE_DUMP_FAIL:-0}" = "1" ]; then echo "docker giả: mongodump thất bại" >&2; exit 1; fi
            printf 'mongo-archive-gia\n' | gzip -c
            exit 0
            ;;
          *mongorestore*)
            cat >/dev/null
            [ "${FAKE_RESTORE_FAIL:-0}" = "1" ] && exit 1
            exit 0
            ;;
        esac
        exit 0
        ;;
    esac
    exit 0
    ;;
  inspect)
    # Network của container MinIO.
    echo "vku-net"
    exit 0
    ;;
  run)
    # Container `mc` dùng một lần: đọc thư mục host từ `-v <host>:/backup` rồi ghi mirror vào đó.
    host=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -v) host="${2%%:*}"; shift 2 ;;
        --env-file) shift 2 ;;
        *) shift ;;
      esac
    done
    if [ "${FAKE_MIRROR_FAIL:-0}" = "1" ]; then echo "docker giả: mc mirror thất bại" >&2; exit 1; fi
    # `mc mirror` của bucket RỖNG không tạo thư mục đích - đúng hành vi đã gặp trên VM production.
    [ "${FAKE_EMPTY_BUCKET:-0}" = "1" ] && exit 0
    key="$host/minio-artifacts/competitions/c1/accounts/a1/submissions/s1"
    mkdir -p "$key"
    printf 'id,prediction\n1001,1\n' >"$key/prediction.csv"
    exit 0
    ;;
esac
exit 0
FAKE
  chmod +x "$ROOT/bin/docker"
}

# ---------------------------------------------------------------- dựng môi trường
setup() {
  ROOT="$(mktemp -d)"
  mkdir -p "$ROOT/bin" "$ROOT/backups" "$ROOT/data/app/competitions/c1/private"
  printf 'ground,truth\n' >"$ROOT/data/app/competitions/c1/private/ground_truth.csv"
  printf 'image: quay.io/minio/minio:RELEASE.2025-09-07T16-13-09Z\n' >"$ROOT/compose.yml"
  printf 'image: quay.io/minio/mc:RELEASE.2025-08-13T08-35-41Z\n' >>"$ROOT/compose.yml"
  cat >"$ROOT/env" <<'ENV'
MINIO_ACCESS_KEY=key-gia
MINIO_SECRET_KEY=secret-gia
MINIO_BUCKET=submission-artifacts
ENV
  install_fake_docker
}

run_backup() {
  OUT="$(
    ALLOW_NON_ROOT=1 \
      COMPOSE_FILE="$ROOT/compose.yml" \
      ENV_FILE="$ROOT/env" \
      DATA_DIR="$ROOT/data" \
      BACKUP_DIR="$ROOT/backups" \
      RETENTION_DAYS="${RETENTION_DAYS:-14}" \
      FAKE_DOCKER_LOG="$ROOT/docker.log" \
      FAKE_HOLD_FILE="$ROOT/hold" \
      FAKE_NO_MINIO="${FAKE_NO_MINIO:-0}" \
      FAKE_EMPTY_BUCKET="${FAKE_EMPTY_BUCKET:-0}" \
      FAKE_MIRROR_FAIL="${FAKE_MIRROR_FAIL:-0}" \
      FAKE_DUMP_FAIL="${FAKE_DUMP_FAIL:-0}" \
      FAKE_RESTORE_FAIL="${FAKE_RESTORE_FAIL:-0}" \
      FAKE_HOLD_DUMP="${FAKE_HOLD_DUMP:-0}" \
      PATH="$ROOT/bin:$PATH" \
      bash "$SCRIPT" 2>&1
  )"
  STATUS=$?
  DEST="$(backup_dirs | tail -n1)"
}

# Chạy backup ở nền và đứng yên trong bước mongodump cho tới khi harness xoá file `hold`.
# Phải chạy THẲNG script (không bọc `bash -c`) để $! đúng là PID của script mà harness định ngắt.
start_held_backup() { # $1=tên file log $2=số thư mục backup đang có
  touch "$ROOT/hold"
  ALLOW_NON_ROOT=1 \
    COMPOSE_FILE="$ROOT/compose.yml" \
    ENV_FILE="$ROOT/env" \
    DATA_DIR="$ROOT/data" \
    BACKUP_DIR="$ROOT/backups" \
    FAKE_DOCKER_LOG="$ROOT/docker.log" \
    FAKE_HOLD_FILE="$ROOT/hold" \
    FAKE_HOLD_DUMP=1 \
    PATH="$ROOT/bin:$PATH" \
    bash "$SCRIPT" >"$1" 2>&1 &
  HELD_PID=$!
  # Chờ tới khi lượt chạy kịp tạo thư mục đích (tức đã qua bước kiểm tra khoá).
  for _ in $(seq 1 50); do
    [ "$(backup_dir_count)" -gt "${2:-0}" ] && break
    sleep 0.1
  done
}

stop_held_backup() { # $1=TERM|KILL, $2=cách trả về ('' hoặc 'wait')
  rm -f "$ROOT/hold"
  kill "-$1" "$HELD_PID" 2>/dev/null || true
  wait "$HELD_PID" 2>/dev/null || true
  sleep 0.2
}

# ---------------------------------------------------------------- kịch bản
setup

begin "bucket có object: backup đủ ba phần, MANIFEST có sha256 khớp file thật"
run_backup
expect_status "backup chạy trọn" 0
expect_in "báo hoàn tất" "$OUT" "Hoàn tất:"
expect_exists "có mongo.archive.gz" "$DEST/mongo.archive.gz"
expect_exists "có app-data.tar.gz" "$DEST/app-data.tar.gz"
expect_exists "có minio-artifacts.tar.gz" "$DEST/minio-artifacts.tar.gz"
if tar -tzf "$DEST/minio-artifacts.tar.gz" 2>/dev/null | grep -q 'prediction.csv'; then
  ok "mirror MinIO vào được archive"
else
  no "archive MinIO không chứa prediction.csv"
fi
expect_missing "không để lại thư mục mirror thô" "$DEST/minio-artifacts"
expect_eq "MANIFEST có sha256 cho cả ba archive" "$(manifest_hashes "$DEST")" "3"
if grep -E '^[0-9a-f]{64}  ' "$DEST/MANIFEST.txt" | sha256sum -c --quiet 2>/dev/null; then
  ok "sha256 trong MANIFEST khớp lại được"
else
  no "sha256 trong MANIFEST không khớp"
fi

begin "bucket rỗng: vẫn thành công với archive rỗng, không tạo thư mục dở dang"
FAKE_EMPTY_BUCKET=1 run_backup
expect_status "backup chạy trọn với bucket rỗng" 0
expect_exists "vẫn có minio-artifacts.tar.gz" "$DEST/minio-artifacts.tar.gz"
expect_exists "vẫn có MANIFEST.txt" "$DEST/MANIFEST.txt"
expect_eq "archive MinIO rỗng, chỉ còn entry thư mục gốc" \
  "$(tar -tzf "$DEST/minio-artifacts.tar.gz" | grep -vc '^minio-artifacts/$')" "0"

begin "mirror MinIO lỗi: dừng, xoá thư mục dở dang, KHÔNG chạy retention"
old="$ROOT/backups/20200101T000000Z"
make_old_backup "$old"
FAKE_MIRROR_FAIL=1 run_backup
expect_status "dừng khi mirror lỗi" 1
expect_in "nói rõ lỗi mirror" "$OUT" "mirror bucket"
expect_eq "không còn thư mục dở dang" "$(partial_count)" "0"
expect_exists "bản cũ vẫn nguyên vì retention chưa chạy" "$old"

begin "bị ngắt giữa đường (SIGTERM): thư mục dở dang bị xoá"
before="$(backup_dir_count)"
start_held_backup "$ROOT/term.log" "$before"
stop_held_backup TERM
expect_eq "không còn thư mục dở dang sau SIGTERM" "$(partial_count)" "0"
expect_in "nói rõ đã xoá bản dở dang" "$(cat "$ROOT/term.log")" "Backup dở dang"

begin "retention chỉ xoá bản cũ SAU khi backup mới thành công"
old="$ROOT/backups/20200101T000000Z"
make_old_backup "$old"
run_backup
expect_status "backup chạy trọn" 0
expect_missing "bản quá hạn bị xoá" "$old"
expect_exists "bản mới còn nguyên" "$DEST/MANIFEST.txt"

begin "chạy chồng lấn: lượt sau bỏ qua thay vì ghi đè"
before="$(backup_dir_count)"
start_held_backup "$ROOT/lock.log" "$before"
dirs_before_lock="$(backup_dirs)"
run_backup
expect_status "lượt chồng lấn thoát êm" 0
expect_in "nói rõ có tiến trình khác" "$OUT" "Đã có tiến trình backup khác đang chạy"
if kill -0 "$HELD_PID" 2>/dev/null; then ok "lượt đang chạy vẫn sống, không bị chen ngang"; else no "lượt đang chạy đã chết"; fi
# Không so nội dung thư mục của lượt đang chạy: `TS` chỉ có độ phân giải giây nên tên đó có thể trùng
# một bản đã hoàn tất trước đó. Thứ chắc chắn đúng là lượt bị khoá không tạo thêm thư mục nào.
expect_eq "lượt chồng lấn không tạo thêm thư mục nào" \
  "$(comm -13 <(printf '%s\n' "$dirs_before_lock") <(backup_dirs) | grep -c . || true)" "0"
stop_held_backup TERM
expect_eq "lượt giữ khoá cũng dọn sạch khi bị ngắt" "$(partial_count)" "0"

rm -rf "$ROOT"

printf '\n----------------------------------------\n'
printf 'kết quả: %d ok, %d fail\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
