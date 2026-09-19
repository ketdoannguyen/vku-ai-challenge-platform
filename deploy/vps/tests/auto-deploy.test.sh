#!/usr/bin/env bash
# Harness cho deploy/vps/auto-deploy.sh: chạy deployer thật trên repo tạm với `docker` giả.
#
#   bash deploy/vps/tests/auto-deploy.test.sh
#
# Không cần Docker, không cần mạng, không cần root. `git` là git thật vì logic so SHA, fetch ref và
# checkout detached là phần phải kiểm chứng thật; `docker` là giả vì phần đó chỉ có nghĩa trên VM
# production và không được phép chạy trong CI.
#
# Harness cố ý KHÔNG dùng `set -e`: một case hỏng phải được đếm rồi đi tiếp, không dừng cả bộ test.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SCRIPT="$REPO_ROOT/deploy/vps/auto-deploy.sh"

PASSED=0
FAILED=0
COUNTER=0
ROOT=""
REPO_DIR=""
OUT=""
STATUS=0

ok() { PASSED=$((PASSED + 1)); printf '  ok   %s\n' "$1"; }
no() { FAILED=$((FAILED + 1)); printf '  FAIL %s\n' "$1"; }
section() { printf '\n== %s\n' "$1"; }

expect_status() {
  if [ "$STATUS" -eq "$2" ]; then ok "$1 (exit $STATUS)"; else no "$1 (exit $STATUS, mong đợi $2)"; fi
}

expect_in() {
  case "$2" in *"$3"*) ok "$1" ;; *) no "$1 - không thấy '$3' trong output: $2" ;; esac
}

expect_not_in() {
  case "$2" in *"$3"*) no "$1 - không mong đợi '$3' trong: $2" ;; *) ok "$1" ;; esac
}

expect_eq() {
  if [ "$2" = "$3" ]; then ok "$1"; else no "$1 - nhận '$2', mong đợi '$3'"; fi
}

docker_log() { cat "$ROOT/docker.log" 2>/dev/null || true; }
docker_calls() { if [ -f "$ROOT/docker.log" ]; then wc -l <"$ROOT/docker.log"; else echo 0; fi; }

# Số lệnh docker có THỂ đổi trạng thái container. `ps`/`logs`/`inspect`/`images` là đọc thuần: watchdog
# Quick Tunnel gọi `ps`+`logs` ở mọi lượt thật, nên chúng không được tính vào bất biến "không đụng
# container khi không có gì để deploy".
docker_mutations() {
  if [ -f "$ROOT/docker.log" ]; then
    grep -cE '^(compose .* (build|up|down|restart|stop|kill)|rmi|tag|pull)( |$)' "$ROOT/docker.log" || true
  else
    echo 0
  fi
}
state_read() { cat "$ROOT/state/$1" 2>/dev/null || true; }
state_write() { printf '%s\n' "$2" >"$ROOT/state/$1"; }
running_revision() { cat "$ROOT/state/running.$1.revision" 2>/dev/null || true; }

# Trạng thái Quick Tunnel mà watchdog nhìn thấy: container cloudflared "đang chạy" và nội dung log.
tunnel_running() { : >"$ROOT/state/cloudflared.running"; }
tunnel_log() { printf '%s\n' "$1" >"$ROOT/state/tunnel.log"; }

# ---------------------------------------------------------------- dựng kịch bản
install_fake_docker() {
  cat >"$ROOT/bin/docker" <<'FAKE'
#!/usr/bin/env bash
# Docker giả: ghi lại mọi lệnh, mô phỏng đủ trạng thái để deployer chạy hết luồng.
set -uo pipefail

printf '%s\n' "$*" >>"$FAKE_DOCKER_LOG"
state="${FAKE_STATE:-/tmp/fake-docker-state}"
mkdir -p "$state"

override_value() { # $1=file $2=service $3=key
  awk -v svc="$2" -v key="$3" '
    $0 == "  " svc ":" { insvc = 1; next }
    /^  [^ ]/ { insvc = 0 }
    insvc && index($0, key ":") { sub(/^[^:]*: */, ""); gsub(/"/, ""); print; exit }
  ' "$1"
}

cmd="${1:-}"
shift || true

case "$cmd" in
  compose)
    override=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --env-file) shift 2 ;;
        -f) override="$2"; shift 2 ;;
        *) break ;;
      esac
    done
    sub="${1:-}"
    shift || true
    case "$sub" in
      build)
        for svc in "$@"; do
          if [ "$svc" = "${FAKE_FAIL_BUILD:-}" ]; then
            echo "docker giả: build $svc thất bại" >&2
            exit 1
          fi
          override_value "$override" "$svc" image >"$state/built.$svc.image"
          override_value "$override" "$svc" revision >"$state/built.$svc.revision"
        done
        exit 0
        ;;
      up)
        # `FAKE_FAIL_UP=1`: chỉ lần `up` ĐẦU TIÊN hỏng (lần của SHA mục tiêu), để rollback ở lần sau
        # vẫn chạy được - đúng như một lần deploy hỏng thật.
        if [ "${FAKE_FAIL_UP:-}" = "1" ] && [ ! -f "$state/up-failed-once" ]; then
          : >"$state/up-failed-once"
          echo "docker giả: up thất bại" >&2
          exit 1
        fi
        svcs=()
        while [ $# -gt 0 ]; do
          case "$1" in
            -d|--no-deps|--wait|-q) shift ;;
            --wait-timeout) shift 2 ;;
            -*) shift ;;
            *) svcs+=("$1"); shift ;;
          esac
        done
        for svc in "${svcs[@]}"; do
          override_value "$override" "$svc" image >"$state/running.$svc.image"
          override_value "$override" "$svc" revision >"$state/running.$svc.revision"
        done
        exit 0
        ;;
      ps)
        svc=""
        incl_stopped=0
        while [ $# -gt 0 ]; do
          case "$1" in
            -q) shift ;;
            -aq|-qa|-a) incl_stopped=1; shift ;;
            *) svc="$1"; shift ;;
          esac
        done
        # `minio`/`minio-init` là hạ tầng dùng chung, nằm NGOÀI override theo SHA nên không có
        # `running.<svc>.revision`. Kịch bản điều khiển chúng bằng FAKE_MINIO_HEALTH /
        # FAKE_MINIO_INIT_EXIT - đúng hai thứ mà preflight của deployer đọc.
        if [ "$svc" = "minio" ]; then
          [ "${FAKE_MINIO_HEALTH:-healthy}" != "none" ] && echo "minio-ctr"
          exit 0
        fi
        if [ "$svc" = "minio-init" ]; then
          if [ "$incl_stopped" -eq 1 ] && [ "${FAKE_MINIO_INIT_EXIT:-0}" != "none" ]; then
            echo "minio-init-ctr"
          fi
          exit 0
        fi
        if [ -n "$svc" ] && [ -s "$state/running.$svc.revision" ]; then echo "${svc}-ctr"; fi
        exit 0
        ;;
      exec)
        while [ $# -gt 0 ]; do
          case "$1" in -T) shift ;; *) break ;; esac
        done
        if [ "${FAKE_HEALTH_FAIL:-}" = "1" ]; then
          echo "docker giả: /api/health không phản hồi" >&2
          exit 8
        fi
        echo '{"status":"ok","mongo":"reachable"}'
        exit 0
        ;;
      *) exit 0 ;;
    esac
    ;;
  inspect)
    # Hai lời gọi của preflight MinIO đọc state khác hẳn lời gọi label của `verify_services`, nên phải
    # phân biệt bằng chính format string chứ không chỉ bằng container id.
    fmt=""
    while [ $# -gt 0 ]; do
      case "$1" in -f) fmt="$2"; shift 2 ;; *) break ;; esac
    done
    case "$fmt" in
      *State.Health*) echo "${FAKE_MINIO_HEALTH:-healthy}"; exit 0 ;;
      *State.ExitCode*) echo "${FAKE_MINIO_INIT_EXIT:-0}"; exit 0 ;;
    esac
    cid="${!#}"
    svc="${cid%-ctr}"
    want="$(cat "$state/running.$svc.revision" 2>/dev/null || echo "")"
    # `FAKE_BAD_LABEL=<sha>`: chỉ trả label sai khi container đang chạy đúng <sha> đó. Nhờ vậy rollback
    # về SHA cũ vẫn xác minh được - đúng như một lần đóng label hỏng thật.
    if [ -n "${FAKE_BAD_LABEL:-}" ] && [ "$want" = "$FAKE_BAD_LABEL" ]; then
      echo "0000000000000000000000000000000000000000"
    else
      echo "$want"
    fi
    exit 0
    ;;
  image)
    # `docker image inspect <ref>`: exit 0 nghĩa là image tồn tại. Chỉ ảnh hưởng nhánh rollback.
    if [ "${FAKE_NO_OLD_IMAGE:-}" = "1" ]; then
      echo "docker giả: không thấy image ${!#}" >&2
      exit 1
    fi
    exit 0
    ;;
  images)
    # `docker images --format '{{.Repository}} {{.Tag}}'` in repo và tag cách nhau bằng dấu cách,
    # không phải `repo:tag` như trong file state.
    if [ -f "$state/images.txt" ]; then
      while IFS= read -r line; do
        [ -n "$line" ] || continue
        printf '%s %s\n' "${line%%:*}" "${line##*:}"
      done <"$state/images.txt"
    fi
    exit 0
    ;;
  ps)
    # `docker ps -q --filter label=com.docker.compose.service=cloudflared` của watchdog Quick Tunnel.
    # Container chỉ "tồn tại" khi kịch bản tạo marker - nhờ vậy test được cả nhánh không có cloudflared.
    case "$*" in
      *com.docker.compose.service=cloudflared*)
        if [ -f "$state/cloudflared.running" ]; then echo "cloudflared-ctr"; fi
        ;;
    esac
    exit 0
    ;;
  logs)
    # `docker logs --tail N <cid>`: nội dung log do kịch bản đặt trong $state/tunnel.log.
    if [ -f "$state/tunnel.log" ]; then cat "$state/tunnel.log"; fi
    exit 0
    ;;
  rmi)
    ref="${1:-}"
    if [ -n "$ref" ] && [ -f "$state/images.txt" ]; then
      sed -i "\|^${ref}$|d" "$state/images.txt"
    fi
    exit 0
    ;;
esac
exit 0
FAKE
  chmod +x "$ROOT/bin/docker"
}

begin() {
  section "$1"
  ROOT="$(mktemp -d)"
  REPO_DIR="$ROOT/repo"
  COUNTER=0
  OUT=""
  STATUS=0
  unset FAKE_FAIL_BUILD FAKE_BAD_LABEL FAKE_HEALTH_FAIL FAKE_NO_OLD_IMAGE FAKE_FAIL_UP
  unset FAKE_MINIO_HEALTH FAKE_MINIO_INIT_EXIT
  mkdir -p "$ROOT/bin" "$ROOT/state"
  : >"$ROOT/env"
  cp "$REPO_ROOT/docker-compose.prod.yml" "$ROOT/compose.yml"
  git init --bare -q "$ROOT/origin.git"
  git init -q "$REPO_DIR"
  git -C "$REPO_DIR" config user.name harness
  git -C "$REPO_DIR" config user.email harness@test
  git -C "$REPO_DIR" remote add origin "$ROOT/origin.git"
  : >"$ROOT/docker.log"
  install_fake_docker
}

# Tạo commit trên nhánh release của repo tạm; CHỈ in ra SHA để `$()` bắt đúng một dòng.
#
# Bộ đếm nằm trong file chứ không phải biến: hàm này luôn được gọi trong `$( )`, nên mọi thay đổi
# biến sẽ mất sau khi subshell kết thúc, và hai commit liên tiếp cho cùng đường dẫn sẽ giống hệt
# nhau (git từ chối commit rỗng). Stdout của git cũng được đẩy sang stderr vì lý do tương tự.
commit() {
  local msg="$1"
  shift
  local path n tip
  n=$(( $(cat "$ROOT/counter" 2>/dev/null || echo 0) + 1 ))
  printf '%s' "$n" >"$ROOT/counter"
  # Luôn commit trên đỉnh release hiện tại của origin, không phải trên HEAD cục bộ: sau khi deployer
  # rollback và checkout detached về SHA cũ, HEAD không còn là cha hợp lệ của release nữa nên push
  # từ đó sẽ bị non-fast-forward.
  tip="$(git -C "$ROOT/origin.git" rev-parse --verify --quiet refs/heads/release || true)"
  if [ -n "$tip" ]; then detach_to "$tip"; fi
  for path in "$@"; do
    mkdir -p "$REPO_DIR/$(dirname "$path")"
    printf '%s rev%s %s\n' "$path" "$n" "$msg" >"$REPO_DIR/$path"
  done
  git -C "$REPO_DIR" add -A >&2
  git -C "$REPO_DIR" -c user.name=harness -c user.email=harness@test commit -q -m "$msg" >&2
  git -C "$REPO_DIR" push -q origin HEAD:refs/heads/release >&2
  git -C "$REPO_DIR" rev-parse HEAD
}

detach_to() { git -C "$REPO_DIR" checkout -q --detach "$1" >&2; }

# Trạng thái đầu của mọi kịch bản: release có đúng một commit nền `BASE`, và worktree đang ở chính
# `BASE` đó - tức VM đang chạy bản cũ còn nhánh release thì đi tiếp.
setup_base() {
  BASE="$(commit "base" backend/app.py frontend/index.html)"
  detach_to "$BASE"
}

setup_deployed() {
  setup_base
  state_write last-success-sha "$BASE"
}

# Thêm một commit lên release rồi trả worktree về `BASE`: mô phỏng "release nhận commit mới trong khi
# VM vẫn đang chạy bản cũ". In ra SHA mới.
advance() {
  local sha
  sha="$(commit "$@")"
  detach_to "$BASE"
  printf '%s' "$sha"
}

run_deploy() {
  OUT="$(
    ALLOW_NON_ROOT=1 \
      REPO="$REPO_DIR" \
      STATE_DIR="$ROOT/state" \
      ENV_FILE="$ROOT/env" \
      COMPOSE_FILE="$ROOT/compose.yml" \
      GIT_URL="$ROOT/origin.git" \
      BRANCH=release \
      FAKE_DOCKER_LOG="$ROOT/docker.log" \
      FAKE_STATE="$ROOT/state" \
      FAKE_FAIL_BUILD="${FAKE_FAIL_BUILD:-}" \
      FAKE_BAD_LABEL="${FAKE_BAD_LABEL:-}" \
      FAKE_HEALTH_FAIL="${FAKE_HEALTH_FAIL:-}" \
      FAKE_NO_OLD_IMAGE="${FAKE_NO_OLD_IMAGE:-}" \
      FAKE_FAIL_UP="${FAKE_FAIL_UP:-}" \
      FAKE_MINIO_HEALTH="${FAKE_MINIO_HEALTH:-healthy}" \
      FAKE_MINIO_INIT_EXIT="${FAKE_MINIO_INIT_EXIT:-0}" \
      PATH="$ROOT/bin:$PATH" \
      bash "$SCRIPT" "$@" 2>&1
  )"
  STATUS=$?
}

# ---------------------------------------------------------------- kịch bản
begin "chưa bootstrap: từ chối deploy tip"
setup_base
run_deploy
expect_status "không có state thì dừng" 1
expect_in "nói rõ cần bootstrap" "$OUT" "chưa có mốc deploy"
expect_eq "không đụng container" "$(docker_mutations)" "0"

: >"$ROOT/docker.log"
run_deploy --bootstrap-current
expect_status "bootstrap-current chạy được" 0
expect_eq "ghi mốc đúng HEAD" "$(state_read last-success-sha)" "$BASE"
expect_eq "bootstrap cũng không gọi docker" "$(docker_calls)" "0"

run_deploy --bootstrap-current
expect_status "không bootstrap lại lần hai" 1
expect_in "giải thích lý do" "$OUT" "không bootstrap lại"

begin "up-to-date: không fetch, không build"
setup_deployed
run_deploy
expect_status "đúng SHA đang chạy thì thoát 0" 0
expect_in "báo không có gì mới" "$OUT" "Không có gì mới"
expect_eq "không đụng container" "$(docker_mutations)" "0"

begin "docs-only: tiến state, không chạm container"
setup_deployed
DOCS="$(advance "docs" docs/DEPLOYMENT.md plans/sprints/SPRINT_10.md README.md deploy/production.env.example)"
run_deploy
expect_status "docs-only thành công" 0
expect_eq "state tiến sang SHA mới" "$(state_read last-success-sha)" "$DOCS"
expect_eq "không đụng container" "$(docker_mutations)" "0"
expect_eq "checkout detached theo SHA mới" "$(git -C "$REPO_DIR" rev-parse HEAD)" "$DOCS"

begin "backend-only: deploy cả api và web (nginx giữ IP của api)"
setup_deployed
BE="$(advance "backend" backend/app.py)"
run_deploy
expect_status "deploy backend thành công" 0
expect_in "build cả hai service" "$(docker_log)" "build api web"
expect_in "up cả hai service" "$(docker_log)" "up -d --no-deps --no-build --wait --wait-timeout 180 api web"
expect_eq "revision api khớp SHA mục tiêu" "$(running_revision api)" "$BE"
expect_eq "revision web khớp SHA mục tiêu" "$(running_revision web)" "$BE"
expect_eq "ghi last-success" "$(state_read last-success-sha)" "$BE"
expect_eq "không xoá last-failed (chưa từng lỗi)" "$(state_read last-failed-sha)" ""

begin "frontend-only: chỉ deploy web"
setup_deployed
FE="$(advance "frontend" frontend/index.html)"
run_deploy
expect_status "deploy frontend thành công" 0
expect_in "build đúng web" "$(docker_log)" "build web"
expect_not_in "không build api" "$(docker_log)" "build api"
expect_not_in "không up api" "$(docker_log)" "web api"
expect_eq "revision web khớp SHA mục tiêu" "$(running_revision web)" "$FE"
expect_eq "api không bị tạo lại nên không có state running" "$(running_revision api)" ""

begin "docker-compose.prod.yml: deploy cả api và web"
setup_deployed
COMPOSE_SHA="$(advance "compose" docker-compose.prod.yml)"
run_deploy
expect_status "đổi compose thì deploy thành công" 0
expect_in "build api web" "$(docker_log)" "build api web"
expect_eq "state tiến" "$(state_read last-success-sha)" "$COMPOSE_SHA"

# ADR-028: `minio`/`minio-init` nằm ngoài override theo SHA nên deployer phải tự kiểm. Điều đáng
# kiểm không phải "có chạy kiểm tra hay không" mà là "khi thiếu thì có dừng TRƯỚC khi thay api/web".
begin "MinIO chưa bootstrap: dừng trước khi thay api/web"
setup_deployed
BE="$(advance "backend" backend/app.py)"

FAKE_MINIO_HEALTH=none
run_deploy
expect_status "thiếu container minio thì dừng" 1
expect_in "nói rõ không thấy minio" "$OUT" "không thấy container 'minio' đang chạy"
expect_in "nói rõ production chưa bị chạm" "$OUT" "KHÔNG thay api/web"
expect_in "in lệnh bootstrap" "$OUT" "up -d minio minio-init"
expect_eq "không build, không up" "$(docker_mutations)" "0"

FAKE_MINIO_HEALTH=healthy
FAKE_MINIO_INIT_EXIT=none
run_deploy
expect_status "minio sống nhưng chưa init thì vẫn dừng" 1
expect_in "nói rõ chưa chạy minio-init" "$OUT" "chưa từng chạy 'minio-init'"
expect_eq "vẫn chưa đụng container" "$(docker_mutations)" "0"

FAKE_MINIO_INIT_EXIT=1
run_deploy
expect_status "minio-init lỗi thì dừng" 1
expect_in "nêu exit code" "$OUT" "'minio-init' kết thúc với exit code 1"
expect_eq "vẫn chưa đụng container" "$(docker_mutations)" "0"
expect_eq "state không tiến" "$(state_read last-success-sha)" "$BASE"
# Không ghi last-failed: lỗi này không nằm ở commit, và cách sửa là chạy bootstrap rồi để lượt timer
# sau deploy nốt chính SHA đó.
expect_eq "không khoá SHA mục tiêu lại" "$(state_read last-failed-sha)" ""
expect_eq "worktree trả về bản đang chạy" "$(git -C "$REPO_DIR" rev-parse HEAD)" "$BASE"
expect_in "ghi history để còn dấu vết" "$(state_read history.log)" "minio-not-bootstrapped"
expect_in "ghi last-failure cho operator" "$(state_read last-failure.txt)" "$BE"

begin "MinIO healthy: deploy bình thường"
setup_deployed
BE="$(advance "backend" backend/app.py)"
FAKE_MINIO_HEALTH=healthy
FAKE_MINIO_INIT_EXIT=0
run_deploy
expect_status "deploy thành công khi MinIO đã bootstrap" 0
expect_in "có kiểm tra bootstrap" "$(docker_log)" "ps -aq minio-init"
expect_eq "revision api khớp SHA mục tiêu" "$(running_revision api)" "$BE"
expect_eq "state tiến" "$(state_read last-success-sha)" "$BE"
# Deployer chỉ quản api/web: mọi lệnh build/up đều không được nhắc tới MinIO.
expect_not_in "không build/up container MinIO" \
  "$(grep -E '^compose .* (build|up) ' "$ROOT/docker.log")" "minio"

# Release không khai MinIO trong compose thì preflight không được chặn - nếu thiếu `needs_minio`,
# lần chạy dưới đây sẽ dừng vì FAKE_MINIO_HEALTH=none.
begin "compose không có MinIO: không chặn deploy"
setup_deployed
BE="$(advance "backend" backend/app.py)"
printf 'services:\n  api:\n    image: x\n' >"$ROOT/compose.yml"
FAKE_MINIO_HEALTH=none
run_deploy
expect_status "không cần MinIO vẫn deploy được" 0
expect_eq "state tiến" "$(state_read last-success-sha)" "$BE"

begin "đường dẫn lạ: fail closed"
setup_deployed
advance "weird" ops/restart-everything.sh >/dev/null
run_deploy
expect_status "đường dẫn chưa phân loại thì dừng" 1
expect_in "nêu rõ file" "$OUT" "ops/restart-everything.sh"
expect_in "nói rõ chưa phân loại" "$OUT" "chưa được phân loại"
expect_eq "không đụng container" "$(docker_mutations)" "0"
expect_eq "state không đổi" "$(state_read last-success-sha)" "$BASE"

begin "working tree bẩn: từ chối deploy"
setup_deployed
advance "backend" backend/app.py >/dev/null
printf 'sua tay\n' >>"$REPO_DIR/backend/app.py"
run_deploy
expect_status "tree bẩn thì dừng" 1
expect_in "nói rõ tree bẩn" "$OUT" "working tree production đang bẩn"
expect_eq "không đụng container" "$(docker_mutations)" "0"

begin "flock: lượt chạy chồng lấn bị bỏ qua"
setup_deployed
advance "backend" backend/app.py >/dev/null
(
  exec 9>"$ROOT/state/.lock"
  flock -n 9
  sleep 3
) &
HOLDER=$!
sleep 0.5
run_deploy
kill "$HOLDER" 2>/dev/null
wait "$HOLDER" 2>/dev/null
expect_status "lượt thứ hai thoát sạch" 0
expect_in "báo bỏ qua vì đang có lượt khác" "$OUT" "Đã có lượt deploy khác đang chạy"
expect_eq "không gọi docker" "$(docker_calls)" "0"

begin "dry-run: chỉ đọc"
setup_deployed
TARGET="$(advance "backend" backend/app.py)"
run_deploy --dry-run
expect_status "dry-run thành công" 0
expect_in "liệt kê file thay đổi" "$OUT" "backend/app.py"
expect_eq "không gọi docker" "$(docker_calls)" "0"
expect_eq "state không đổi" "$(state_read last-success-sha)" "$BASE"
expect_eq "HEAD không đổi" "$(git -C "$REPO_DIR" rev-parse HEAD)" "$BASE"
expect_eq "không ghi last-failed" "$(state_read last-failed-sha)" ""
expect_eq "target vẫn được đọc đúng" "$(git -C "$REPO_DIR" rev-parse refs/vku-deploy/release)" "$TARGET"

begin "build lỗi: giữ nguyên production đang chạy"
setup_deployed
TARGET="$(advance "backend" backend/app.py)"
FAKE_FAIL_BUILD=api
run_deploy
expect_status "build lỗi thì thoát khác 0" 1
expect_in "nói production vẫn chạy bản cũ" "$OUT" "production vẫn đang chạy"
expect_eq "last-success không đổi" "$(state_read last-success-sha)" "$BASE"
expect_eq "đánh dấu SHA lỗi" "$(state_read last-failed-sha)" "$TARGET"
expect_not_in "không gọi up" "$(docker_log)" "up -d"
expect_eq "trả worktree về bản đang chạy" "$(git -C "$REPO_DIR" rev-parse HEAD)" "$BASE"
expect_eq "không rollback (chưa có gì để rollback)" "$(running_revision api)" ""

begin "up lỗi: rollback ngay trong cùng lượt"
setup_deployed
state_write running.api.revision "$BASE"
state_write running.web.revision "$BASE"
TARGET="$(advance "backend" backend/app.py)"
FAKE_FAIL_UP=1
run_deploy
expect_status "up lỗi thì thất bại" 1
expect_in "nói rõ đã rollback" "$OUT" "đã rollback về ${BASE:0:12}"
expect_in "rollback chạy trên SHA cũ" "$OUT" "về image của ${BASE:0:12}"
expect_eq "container chạy lại revision cũ" "$(state_read running.api.revision)" "$BASE"
expect_eq "last-success không đổi" "$(state_read last-success-sha)" "$BASE"
expect_eq "đánh dấu SHA lỗi" "$(state_read last-failed-sha)" "$TARGET"
expect_eq "worktree về bản đang chạy" "$(git -C "$REPO_DIR" rev-parse HEAD)" "$BASE"

begin "SHA lỗi: không thử lại ở lượt sau"
setup_deployed
TARGET="$(advance "backend" backend/app.py)"
FAKE_FAIL_BUILD=api
run_deploy
expect_status "lượt đầu lỗi" 1
: >"$ROOT/docker.log"
run_deploy
expect_status "lượt sau thoát sạch" 0
expect_in "báo không thử lại" "$OUT" "đã thất bại trước đó"
expect_eq "không đụng container" "$(docker_mutations)" "0"

begin "SHA mới sau SHA lỗi: thử một lần"
setup_deployed
advance "backend" backend/app.py >/dev/null
FAKE_FAIL_BUILD=api
run_deploy
expect_status "SHA lỗi ghi nhận" 1
FAKE_FAIL_BUILD=""
NEW="$(advance "backend fix" backend/app.py)"
run_deploy
expect_status "SHA mới được deploy" 0
expect_eq "state tiến sang SHA mới" "$(state_read last-success-sha)" "$NEW"
expect_eq "revision api khớp SHA mới" "$(running_revision api)" "$NEW"

begin "revision sai sau up: rollback bằng image cũ, không rebuild"
setup_deployed
# Lần deploy trước đã chạy thành công nên mới có image cũ để quay về.
state_write running.api.revision "$BASE"
state_write running.web.revision "$BASE"
TARGET="$(advance "backend" backend/app.py)"
FAKE_BAD_LABEL="$TARGET"
run_deploy
expect_status "revision lệch thì thất bại" 1
expect_in "nói rõ rollback" "$OUT" "ROLLBACK"
expect_in "rollback về SHA cũ" "$OUT" "về image của ${BASE:0:12}"
expect_eq "last-success không đổi" "$(state_read last-success-sha)" "$BASE"
expect_eq "đánh dấu SHA lỗi" "$(state_read last-failed-sha)" "$TARGET"
expect_eq "chỉ build một lần cho SHA mục tiêu (rollback không build lại)" \
  "$(grep -c '^compose .* build ' "$ROOT/docker.log")" "1"
expect_eq "container chạy lại revision cũ" "$(state_read running.api.revision)" "$BASE"
expect_eq "worktree về bản đang chạy" "$(git -C "$REPO_DIR" rev-parse HEAD)" "$BASE"

begin "không có image cũ: từ chối rollback, không build bù"
setup_deployed
# Mô phỏng đúng đường docs-only/bootstrap: state đã tiến nhưng chưa từng build image cho SHA đó.
state_write running.api.revision "$BASE"
state_write running.web.revision "$BASE"
TARGET="$(advance "backend" backend/app.py)"
FAKE_BAD_LABEL="$TARGET"
FAKE_NO_OLD_IMAGE=1
run_deploy
expect_status "không rollback được thì thất bại" 1
expect_in "nói rõ không có image cũ" "$OUT" "không có image của ${BASE:0:12}"
expect_not_in "không up lại bằng image bịa" "$OUT" "đã rollback"
# Điểm mấu chốt: `docker compose up` tự build khi image vắng mặt, nên nếu deployer không chặn trước
# thì nó sẽ build source MỚI dưới tag + label của SHA CŨ và báo rollback thành công.
expect_eq "rollback không được build bù" "$(grep -c '^compose .* build ' "$ROOT/docker.log")" "1"
expect_eq "không có lệnh up nào của rollback" \
  "$(grep -c 'rollback-override.yml up' "$ROOT/docker.log")" "0"
expect_eq "đánh dấu SHA lỗi để timer không thử lại" "$(state_read last-failed-sha)" "$TARGET"

begin "health hỏng sau up: rollback"
setup_deployed
state_write running.api.revision "$BASE"
state_write running.web.revision "$BASE"
TARGET="$(advance "backend" backend/app.py)"
FAKE_HEALTH_FAIL=1
run_deploy
expect_status "health hỏng thì thất bại" 1
expect_in "báo rollback" "$OUT" "ROLLBACK"
# Health giả hỏng với mọi lần gọi nên rollback cũng không xác minh được: đây là nhánh "rollback
# cũng hỏng", phải chỉ đúng chỗ cho người trực và không được chết vì biến chưa gán.
expect_in "chỉ chỗ can thiệp tay khi rollback cũng hỏng" "$OUT" "history.log"
expect_eq "container chạy lại revision cũ" "$(state_read running.api.revision)" "$BASE"
expect_eq "last-success không đổi" "$(state_read last-success-sha)" "$BASE"
expect_eq "đánh dấu SHA lỗi" "$(state_read last-failed-sha)" "$TARGET"

begin "audit lệnh Compose: đủ cờ, không chạm mongo/cloudflared/down/volume"
setup_deployed
advance "backend" backend/app.py >/dev/null
printf 'vku-challenge-api:%s\nvku-challenge-api:prod\nvku-challenge-web:%s\nvku-challenge-api:deadbeef0000\n' \
  "${BASE:0:12}" "${BASE:0:12}" >"$ROOT/state/images.txt"
run_deploy
expect_status "deploy thành công" 0
LOG="$(docker_log)"
expect_in "mọi lệnh compose đều có --env-file" "$LOG" "--env-file $ROOT/env"
expect_in "mọi lệnh compose đều có base -f" "$LOG" "-f $ROOT/compose.yml"
if grep -q '^compose ' <<<"$LOG" && ! grep -q '^compose --env-file ' <<<"$LOG"; then
  no "có lệnh compose thiếu --env-file"
else
  ok "không có lệnh compose nào thiếu --env-file"
fi
MISSING_OVERRIDE="$(grep '^compose ' <<<"$LOG" | grep -vc " -f $ROOT/state/.*override.yml")"
expect_eq "mọi lệnh compose đều có file override" "$MISSING_OVERRIDE" "0"
# `up` mà thiếu `--no-build` sẽ tự build khi image vắng mặt; đó là đường khiến rollback dựng lại
# source mới dưới nhãn SHA cũ.
MISSING_NO_BUILD="$(grep '^compose ' <<<"$LOG" | grep ' up ' | grep -vc -- '--no-build')"
expect_eq "mọi lệnh up đều có --no-build" "$MISSING_NO_BUILD" "0"
expect_not_in "không đụng mongo" "$LOG" " mongo"
# Watchdog Quick Tunnel chỉ ĐỌC cloudflared (`docker ps`, `docker logs`). Bất biến thật là deployer
# không bao giờ ĐỔI TRẠNG THÁI container này - restart nó là đổi URL công khai và làm chết API_ORIGIN.
# (`$LOG` là NỘI DUNG log, nên phải đưa vào qua herestring - không phải đối số tên file.)
expect_eq "không đổi trạng thái cloudflared" \
  "$(grep -E 'cloudflared' <<<"$LOG" | grep -cE '^(compose .* (build|up|down|restart|stop|kill)|restart|stop|kill|rm)( |$)' || true)" "0"
expect_not_in "không có compose down" "$LOG" " down"
expect_not_in "không prune" "$LOG" "prune"
expect_not_in "không đụng volume" "$LOG" "volume"
# Kiểm trên danh sách image còn lại, không phải trên docker.log: `prune_images` chỉ gọi `docker
# images` (đọc) rồi `docker rmi` (xoá), nên docker.log không bao giờ chứa tên tag được giữ.
expect_eq "giữ tag :prod cho lệnh thủ công" \
  "$(grep -c 'vku-challenge-api:prod' "$ROOT/state/images.txt")" "1"
expect_eq "tag SHA cũ đã bị xoá" "$(grep -c 'deadbeef0000' "$ROOT/state/images.txt")" "0"
expect_eq "tag của SHA đang chạy được giữ" "$(grep -c "vku-challenge-api:${BASE:0:12}" "$ROOT/state/images.txt")" "1"

begin "an toàn: từ chối chạy khi không phải root"
setup_base
OUT="$(
  REPO="$REPO_DIR" STATE_DIR="$ROOT/state" ENV_FILE="$ROOT/env" \
    COMPOSE_FILE="$ROOT/compose.yml" GIT_URL="$ROOT/origin.git" BRANCH=release \
    FAKE_DOCKER_LOG="$ROOT/docker.log" FAKE_STATE="$ROOT/state" \
    PATH="$ROOT/bin:$PATH" bash "$SCRIPT" 2>&1
)"
STATUS=$?
expect_status "không phải root thì dừng" 1
expect_in "nói rõ cần sudo" "$OUT" "phải chạy bằng sudo"
expect_eq "không gọi docker" "$(docker_calls)" "0"

begin "watchdog Quick Tunnel: phát hiện URL đổi"
setup_deployed
tunnel_running
tunnel_log '2026-09-19T00:00:00Z INF |  https://alpha-beta-gamma.trycloudflare.com  |'
run_deploy
expect_status "lượt đầu chạy sạch" 0
expect_eq "ghi nhận URL lần đầu" "$(state_read quick-tunnel-url)" "https://alpha-beta-gamma.trycloudflare.com"
expect_not_in "lần đầu không báo động" "$OUT" "CẢNH BÁO"

run_deploy
expect_status "lượt sau vẫn sạch" 0
expect_in "vẫn báo không có gì mới" "$OUT" "Không có gì mới"
expect_not_in "URL không đổi thì im lặng" "$OUT" "CẢNH BÁO"

tunnel_log '2026-09-19T01:00:00Z INF |  https://delta-epsilon-zeta.trycloudflare.com  |'
run_deploy
expect_status "lượt đổi URL vẫn thoát 0" 0
expect_in "báo URL đã đổi" "$OUT" "CẢNH BÁO: Quick Tunnel URL đã đổi"
expect_in "in ra URL cũ" "$OUT" "https://alpha-beta-gamma.trycloudflare.com"
expect_in "in ra URL mới" "$OUT" "https://delta-epsilon-zeta.trycloudflare.com"
expect_in "chỉ đúng chỗ sửa" "$OUT" "Variables and Secrets > API_ORIGIN"
expect_eq "state theo URL mới" "$(state_read quick-tunnel-url)" "https://delta-epsilon-zeta.trycloudflare.com"
expect_in "ghi sự kiện vào history" "$(state_read history.log)" "result=tunnel-url-changed"
expect_eq "đổi URL không làm deploy thêm" "$(docker_mutations)" "0"

begin "watchdog: log mất URL thì giữ giá trị cũ, không báo động giả"
setup_deployed
tunnel_running
tunnel_log '2026-09-19T00:00:00Z INF |  https://alpha-beta-gamma.trycloudflare.com  |'
run_deploy
state_write quick-tunnel-url "https://giu-nguyen.trycloudflare.com"
tunnel_log '2026-09-19T02:00:00Z INF |  log da bi xoay, khong con dong URL  |'
run_deploy
expect_status "vẫn chạy sạch" 0
expect_eq "không ghi đè bằng rỗng" "$(state_read quick-tunnel-url)" "https://giu-nguyen.trycloudflare.com"
expect_not_in "không báo động giả" "$OUT" "CẢNH BÁO"

begin "watchdog: không có container cloudflared thì im lặng"
setup_deployed
tunnel_log '2026-09-19T00:00:00Z INF |  https://alpha-beta-gamma.trycloudflare.com  |'
run_deploy
expect_status "chạy sạch khi cloudflared không chạy" 0
expect_eq "không ghi state" "$(state_read quick-tunnel-url)" ""
expect_not_in "không báo động" "$OUT" "CẢNH BÁO"

begin "watchdog: dry-run và bootstrap không ghi state"
setup_deployed
tunnel_running
tunnel_log '2026-09-19T00:00:00Z INF |  https://alpha-beta-gamma.trycloudflare.com  |'
advance "backend" backend/app.py >/dev/null
run_deploy --dry-run
expect_status "dry-run thành công" 0
expect_eq "dry-run không ghi URL tunnel" "$(state_read quick-tunnel-url)" ""
expect_eq "dry-run không gọi docker" "$(docker_calls)" "0"

# ---------------------------------------------------------------- tổng kết
printf '\n----------------------------------------\n'
printf 'kết quả: %s ok, %s fail\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ] || exit 1
