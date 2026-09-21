#!/usr/bin/env bash
# Auto-deploy production VKU AI Challenge từ nhánh `release`.
#
#   sudo /usr/local/sbin/vku-auto-deploy --bootstrap-current   # một lần, ghi mốc SHA hiện tại
#   sudo /usr/local/sbin/vku-auto-deploy --dry-run             # xem sẽ deploy gì, không đổi gì
#   sudo /usr/local/sbin/vku-auto-deploy                       # một lượt deploy (systemd timer gọi)
#
# Bản chạy production là BẢN COPY root-owned ở /usr/local/sbin, không phải file trong repo: một release
# xấu không được phép tự thay cơ chế recovery của chính nó. Cập nhật deployer là thao tác có chủ ý bằng
# cách chạy lại `deploy/vps/install-auto-deploy.sh` từ commit đã duyệt.
#
# Nguyên tắc an toàn:
#   - Không log cookie/session/token/secret. Không `set -x` (sẽ in cả lệnh lẫn giá trị nội suy).
#   - Không bao giờ chạm `mongo`, `cloudflared`, volume, `/srv/vku-ai-challenge/data` hay backups.
#     Riêng `cloudflared` còn đang chạy Quick Tunnel: restart nó là đổi URL công khai và làm chết
#     `API_ORIGIN` của Worker.
#   - Chỉ dùng `docker compose build/up/ps/exec`, không `down`, không `down -v`, không prune. Ngoại lệ
#     duy nhất: `rm -sf ai-review-worker` khi rollback qua commit giới thiệu worker (ADR-036) - đúng
#     một service, không đụng gì khác.
#   - Mỗi SHA lỗi chỉ thử một lần; muốn thử lại thì push commit mới (không sửa state tay).
#   - `minio`/`minio-init` nằm NGOÀI override theo SHA. Release cần artifact backend mà MinIO chưa
#     bootstrap thì deploy dừng trước khi thay api/web và in lệnh bootstrap (ADR-028, §13 kế hoạch).

set -euo pipefail

# ---------------------------------------------------------------- cấu hình
# Tất cả đều override được qua biến môi trường để test harness chạy được trên repo tạm. Unit systemd
# của production KHÔNG truyền biến nào, nên giá trị mặc định dưới đây chính là cấu hình thật.
REPO="${REPO:-/srv/vku-ai-challenge/repo}"
STATE_DIR="${STATE_DIR:-/var/lib/vku-deploy}"
ENV_FILE="${ENV_FILE:-/srv/vku-ai-challenge/.env}"
COMPOSE_FILE="${COMPOSE_FILE:-$REPO/docker-compose.prod.yml}"
GIT_URL="${GIT_URL:-https://github.com/ketdoannguyen/vku-ai-challenge-platform.git}"
BRANCH="${BRANCH:-release}"
WAIT_TIMEOUT="${WAIT_TIMEOUT:-180}"

DEPLOY_REF="refs/vku-deploy/$BRANCH"
IMAGE_API="vku-challenge-api"
IMAGE_WEB="vku-challenge-web"
WORKER_SERVICE="ai-review-worker"
RUNTIME_OVERRIDE="$STATE_DIR/runtime-override.yml"
ROLLBACK_OVERRIDE="$STATE_DIR/rollback-override.yml"

# Đường dẫn compose TƯƠNG ĐỐI trong repo: `git show <sha>:<path>` chỉ nhận path trong cây, không nhận
# đường dẫn tuyệt đối. COMPOSE_FILE mặc định nằm trong repo nên đây là trường hợp thường gặp.
COMPOSE_REL="${COMPOSE_FILE#"$REPO"/}"

# ---------------------------------------------------------------- tiện ích
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "LỖI: $*" >&2; exit 1; }

usage() {
  sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
}

# Git chạy bằng root trên repo có thể thuộc user khác: `safe.directory` phải truyền theo từng lệnh,
# không sửa `~/.gitconfig` của root.
git_repo() { git -c "safe.directory=$REPO" -C "$REPO" "$@"; }

# Điểm vào DUY NHẤT của mọi lệnh Compose.
#   - Thiếu `--env-file` thì `${MONGO_USER:?}` trong compose file làm lệnh dừng ngay.
#   - Thiếu file override thì container chạy nhầm tag `:prod` cố định - tag này không phân biệt được
#     "image mới build xong" với "image cũ còn sót lại", nên không dùng làm bằng chứng deploy.
compose() {
  local override="$1"
  shift
  docker compose \
    --env-file "$ENV_FILE" \
    -f "$COMPOSE_FILE" \
    -f "$override" \
    "$@"
}

state_get() {
  local file="$STATE_DIR/$1"
  [ -f "$file" ] && tr -d '\n' <"$file" || true
}

# Ghi state bằng temp + mv để lần đọc kế tiếp không bao giờ thấy file dở dang.
state_set() {
  local file="$STATE_DIR/$1"
  local tmp="$STATE_DIR/.$1.tmp"
  printf '%s\n' "$2" >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$file"
}

history_add() {
  printf '%s sha=%s result=%s services=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "${3:-none}" >>"$STATE_DIR/history.log"
}

# Image của một service. Worker dùng CHUNG image backend với `api` (cùng Dockerfile, chỉ khác
# `command`), nên nó không bao giờ có image riêng: build một lần, rollback một lần, và không có
# đường nào để api/worker lệch code nhau.
image_for_service() {
  case "$1" in
    api|"$WORKER_SERVICE") printf '%s' "$IMAGE_API" ;;
    web) printf '%s' "$IMAGE_WEB" ;;
    *) return 1 ;;
  esac
}

# Ghi lại override trỏ service về image tag theo SHA.
write_override() {
  local path="$1" sha="$2"
  shift 2
  local tmp="$path.tmp" svc image
  {
    printf '# Sinh tự động bởi vku-auto-deploy - KHÔNG sửa tay.\n'
    printf 'services:\n'
    for svc in "$@"; do
      image="$(image_for_service "$svc")" || die "service không hỗ trợ: $svc"
      printf '  %s:\n' "$svc"
      printf '    image: %s:%s\n' "$image" "${sha:0:12}"
      printf '    build:\n'
      printf '      labels:\n'
      printf '        org.opencontainers.image.revision: "%s"\n' "$sha"
    done
  } >"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$path"
}

# Đường dẫn không cần dựng lại container: chỉ là tài liệu, cấu hình CI, hoặc chính bộ deployer.
# `scripts/backup_prod.sh` nằm trong đây vì bản production đã được đóng băng ở
# /usr/local/sbin/vku-backup-prod - sửa file trong repo chỉ có hiệu lực khi operator chạy lại installer.
# `.env.example` chỉ là mẫu tham chiếu trong repo; stack production đọc `/srv/vku-ai-challenge/.env`,
# không đọc file này, nên đổi nó không thể đòi dựng lại container nào.
is_no_container_path() {
  case "$1" in
    .github/*|docs/*|plans/*|deploy/*|scripts/*) return 0 ;;
    .env.example|PROJECT_TREE.txt|docker-compose.yml|*.md) return 0 ;;
    *) return 1 ;;
  esac
}

# Mọi đường dẫn khác đều fail closed: một file lạ có thể là build context hoặc script vận hành mà
# người viết deployer không lường được, nên dừng lại để operator phân loại thay vì đoán.
map_changed_paths() {
  local path
  for path in "$@"; do
    case "$path" in
      # Đổi backend BẮT BUỘC deploy lại cả `web`, không phải chỉ `api`:
      # nginx trong `web` trỏ thẳng `proxy_pass http://api:8000` và không có `resolver`, nên nó
      # phân giải IP của `api` đúng một lần lúc khởi động. `api` được tạo lại là mang IP mới, còn
      # `web` cũ sẽ proxy vào IP đã chết cho tới khi chính nó được tạo lại.
      # Worker chạy đúng source backend đó, nên nó đi kèm `api` trong mọi lượt backend đổi.
      backend/*) NEED_API=1; NEED_WORKER=1; NEED_WEB=1 ;;
      frontend/*) NEED_WEB=1 ;;
      docker-compose.prod.yml) NEED_API=1; NEED_WORKER=1; NEED_WEB=1 ;;
      *)
        is_no_container_path "$path" || die "đường dẫn chưa được phân loại trong $path: $path - dừng để operator xử lý"
        ;;
    esac
  done
}

fetch_target() {
  local target="$1"
  git_repo fetch --no-tags --quiet "$GIT_URL" "+refs/heads/$BRANCH:$DEPLOY_REF" ||
    die "fetch nhánh $BRANCH thất bại"
  local fetched
  fetched="$(git_repo rev-parse "$DEPLOY_REF^{commit}")"
  [ "$fetched" = "$target" ] ||
    die "ref vừa fetch ($fetched) khác SHA đọc được từ ls-remote ($target) - nhánh vừa đổi, lần sau sẽ xử lý"
}

# Xác nhận container đang chạy ĐÚNG image của SHA mục tiêu. Chỉ nhìn trạng thái "healthy" là không đủ:
# một image cũ còn sót lại vẫn healthy, và khi đó deploy được ghi nhận thành công trong khi code mới
# chưa hề chạy.
verify_services() {
  local override="$1" sha="$2"
  shift 2
  local svc cid label
  for svc in "$@"; do
    cid="$(compose "$override" ps -q "$svc")"
    [ -n "$cid" ] || { log "LỖI: không thấy container nào cho service $svc"; return 1; }
    label="$(docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$cid")"
    [ "$label" = "$sha" ] ||
      { log "LỖI: $svc chạy revision '$label', mong đợi '$sha'"; return 1; }
  done
  return 0
}

# `minio`/`minio-init` là hạ tầng dùng chung, KHÔNG nằm trong override theo SHA (deployer chỉ quản
# `api`, `ai-review-worker` và `web`), nên một release cần artifact backend có thể gặp stack chưa
# từng bootstrap MinIO.
# Nhận biết bằng chính compose file của SHA mục tiêu: release cũ chưa khai `minio` thì không cần.
needs_minio() {
  grep -qE '^[[:space:]]+minio:[[:space:]]*$' "$COMPOSE_FILE"
}

# MinIO phải bootstrap XONG trước khi thay container backend: API mới ghi artifact vào bucket ngay từ
# request đầu tiên, còn `minio-init` mới là thứ tạo bucket + credential app. Đổi api trước khi có hai
# thứ đó biến mọi lượt nộp thành lỗi 503. Trả về 1 kèm lý do cụ thể để log nói đúng việc cần làm.
check_minio_bootstrap() {
  local cid status
  cid="$(compose "$RUNTIME_OVERRIDE" ps -q minio)"
  if [ -z "$cid" ]; then
    log "MinIO: không thấy container 'minio' đang chạy"
    return 1
  fi
  # Không có healthcheck thì Docker trả chuỗi rỗng - vẫn là chưa sẵn sàng, không phải "đạt".
  status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$cid")"
  if [ "$status" != "healthy" ]; then
    log "MinIO: container 'minio' ở trạng thái '${status:-không có healthcheck}'"
    return 1
  fi
  # `minio` sống không có nghĩa là bucket/credential đã tồn tại: minio-init là service một lần, chỉ
  # chạy khi có người gọi. Exit code 0 của nó là bằng chứng duy nhất cho "đã bootstrap".
  cid="$(compose "$RUNTIME_OVERRIDE" ps -aq minio-init)"
  if [ -z "$cid" ]; then
    log "MinIO: chưa từng chạy 'minio-init' (bucket và credential app chưa được tạo)"
    return 1
  fi
  status="$(docker inspect -f '{{.State.ExitCode}}' "$cid")"
  if [ "$status" != "0" ]; then
    log "MinIO: 'minio-init' kết thúc với exit code $status"
    return 1
  fi
  return 0
}

# Kiểm tra end-to-end qua đúng đường đi thật của người dùng trong Docker network: nginx -> FastAPI ->
# Mongo. Không dùng `cloudflared` làm oracle vì nó đang là Quick Tunnel và không thuộc phạm vi deploy.
check_health() {
  local override="$1" body
  if ! body="$(compose "$override" exec -T web wget -q -O - http://127.0.0.1/api/health 2>&1)"; then
    log "LỖI: gọi /api/health qua web thất bại"
    return 1
  fi
  case "$body" in
    *'"status":"ok"'*) log "Health OK: $body"; return 0 ;;
    *) log "LỖI: /api/health trả về: $body"; return 1 ;;
  esac
}

# Giữ lại đúng hai bộ image của lần thành công hiện tại và lần trước; xoá các tag SHA cũ hơn.
# Chỉ `docker rmi` theo đúng tag của project, không prune, không chạm volume.
prune_images() {
  local keep_a="$1" keep_b="$2" repo tag keep
  while read -r repo tag; do
    case "$repo" in
      "$IMAGE_API"|"$IMAGE_WEB") ;;
      *) continue ;;
    esac
    # `:prod` là tag cố định trong compose file: giữ để các lệnh thủ công trong runbook vẫn chạy.
    [ "$tag" = "prod" ] && continue
    keep=0
    [ "$tag" = "${keep_a:0:12}" ] && keep=1
    [ -n "$keep_b" ] && [ "$tag" = "${keep_b:0:12}" ] && keep=1
    [ "$keep" -eq 1 ] && continue
    docker rmi "$repo:$tag" >/dev/null 2>&1 ||
      log "Không xoá được $repo:$tag (có thể đang được container khác dùng) - bỏ qua"
  done < <(docker images --format '{{.Repository}} {{.Tag}}')
}

# Image của một SHA có thật trên máy này không. Dùng để phân biệt "quay về bản cũ đã build" với
# "không có gì để quay về" trước khi đụng vào container đang chạy.
has_image() {
  local tag="$1"
  shift
  local svc image
  for svc in "$@"; do
    image="$(image_for_service "$svc")" || return 1
    docker image inspect "$image:$tag" >/dev/null 2>&1 || return 1
  done
}

# Một service có được KHAI trong compose của release tại SHA đó hay không. Đọc đúng file compose của
# SHA cũ bằng `git show` thay vì bản đang nằm trong working tree: lúc rollback, working tree đang ở SHA
# mục tiêu nên nó luôn khai worker, kể cả khi bản cũ chưa từng có service này.
release_defines_service() {
  local sha="$1" svc="$2" content
  content="$(git_repo show "$sha:$COMPOSE_REL" 2>/dev/null)" || return 1
  grep -qE "^[[:space:]]+$svc:[[:space:]]*$" <<<"$content"
}

# Khôi phục image của lần deploy thành công trước đó. KHÔNG build lại source cũ: build lại là một
# phép toán không xác định (base image, cache, dependency) đúng vào lúc production đang lỗi.
do_rollback() {
  local sha="$1"
  shift
  local svc
  local -a services=()

  # Worker chỉ tồn tại từ release giới thiệu nó. Chạy `up ai-review-worker` bằng image cũ không có
  # module `app.ai_review.worker` là dựng một container crash-loop, và `--wait` sẽ cháy hết thời gian
  # chờ - rollback thất bại vì một service mà người dùng cuối không cần để làm việc. Bỏ nó khỏi lượt
  # rollback và dọn container còn sót của release vừa hỏng.
  for svc in "$@"; do
    if [ "$svc" = "$WORKER_SERVICE" ] && ! release_defines_service "$sha" "$WORKER_SERVICE"; then
      log "Rollback: bản ${sha:0:12} chưa khai $WORKER_SERVICE - dọn container thay vì chạy lại nó."
      compose "$RUNTIME_OVERRIDE" rm -sf "$WORKER_SERVICE" >/dev/null 2>&1 ||
        log "Không dọn được container $WORKER_SERVICE (có thể chưa từng tồn tại) - bỏ qua"
      continue
    fi
    services+=("$svc")
  done
  [ "${#services[@]}" -gt 0 ] || { log "LỖI: rollback không còn service nào để chạy"; return 1; }
  log "ROLLBACK: đưa ${services[*]} về image của ${sha:0:12}"

  # Bắt buộc kiểm tra trước khi `up`: `docker compose up` TỰ BUILD khi image vắng mặt. Lúc này working
  # tree đang ở SHA mục tiêu (đã checkout ở trên), nên nếu image của SHA cũ không còn, compose sẽ build
  # source MỚI rồi gắn tag + label của SHA CŨ - container chạy code mới nhưng mang danh nghĩa bản cũ,
  # và `verify_services` (chỉ đọc label) sẽ báo rollback thành công. Đây là đường có thật: commit
  # docs-only hoặc `--bootstrap-current` đều tiến state mà không build image nào.
  if ! has_image "${sha:0:12}" "${services[@]}"; then
    log "LỖI: không có image của ${sha:0:12} trên máy này - KHÔNG rollback được (không build lại source cũ)"
    return 1
  fi

  write_override "$ROLLBACK_OVERRIDE" "$sha" "${services[@]}"
  # `--no-build` chốt lại điều đã kiểm ở trên: nếu image biến mất giữa chừng thì `up` phải thất bại
  # chứ không được build bù.
  if ! compose "$ROLLBACK_OVERRIDE" up -d --no-deps --no-build --wait --wait-timeout "$WAIT_TIMEOUT" "${services[@]}"; then
    log "LỖI: rollback không khởi động được image cũ (${sha:0:12})"
    return 1
  fi
  if ! verify_services "$ROLLBACK_OVERRIDE" "$sha" "${services[@]}" || ! check_health "$ROLLBACK_OVERRIDE"; then
    log "LỖI: rollback đã chạy nhưng revision/health không khớp"
    return 1
  fi
  git_repo checkout --detach "$sha" >/dev/null 2>&1 || log "Cảnh báo: không checkout lại được ${sha:0:12}"
  return 0
}

# ---------------------------------------------------------------- Quick Tunnel
# Quick Tunnel sinh URL ngẫu nhiên MỚI mỗi lần container `cloudflared` khởi động, còn Worker giữ
# `API_ORIGIN` trong runtime variable. URL đổi mà không ai cập nhật `API_ORIGIN` thì mọi `/api/*` trả
# 502 cho tới khi có người phát hiện. Timer deployer là thứ duy nhất chạy đều đặn trên VM, nên nó là
# chỗ duy nhất phát hiện được sự kiện này.
#
# Chỉ PHÁT HIỆN và báo, cố ý KHÔNG tự sửa: tự sửa đòi hỏi một token quản trị Worker thường trú trên
# VPS, tức nhân bản quyền Cloudflare sang máy thứ hai chỉ để phục vụ một sự kiện xảy ra khi
# `cloudflared` restart. Người vận hành sửa bằng Dashboard, mất một phút.
#
# Chỉ đọc (`docker ps`, `docker logs`); không đụng container nào.
check_quick_tunnel() {
  local cid url stored
  cid="$(docker ps -q --filter 'label=com.docker.compose.service=cloudflared')" || return 0
  cid="${cid%%$'\n'*}"
  [ -n "$cid" ] || return 0
  # Lấy kết quả KHỚP CUỐI CÙNG (`tail -n1`), không phải đầu tiên: container restart thì Docker ghi
  # tiếp vào cùng file log, nên URL mới nằm sau URL cũ. Cửa sổ `--tail` rộng để URL mới không bị đẩy
  # ra ngoài phạm vi đọc; `--tail` không giới hạn chi phí ở mức nào đáng kể.
  url="$(docker logs --tail 1000 "$cid" 2>&1 |
    grep -oE 'https://[a-z0-9][a-z0-9-]*\.trycloudflare\.com' | tail -n1)" || true
  # Không tìm thấy URL (log đã bị xoay, container vừa restart chưa kịp in, hoặc đang chạy named
  # tunnel): giữ nguyên giá trị đã lưu. Ghi đè bằng rỗng sẽ biến lượt sau thành báo động giả.
  [ -n "$url" ] || return 0
  stored="$(state_get quick-tunnel-url)"
  [ "$url" != "$stored" ] || return 0
  state_set quick-tunnel-url "$url"
  if [ -z "$stored" ]; then
    log "Quick Tunnel: ghi nhận URL hiện tại $url"
    return 0
  fi
  log "CẢNH BÁO: Quick Tunnel URL đã đổi - /api/* trả 502 tới khi cập nhật API_ORIGIN của Worker."
  log "  cũ : $stored"
  log "  mới: $url"
  log "  sửa: Cloudflare Dashboard > Workers & Pages > vku-ai-challenge-platform > Settings > Variables and Secrets > API_ORIGIN"
  history_add "-" "tunnel-url-changed" "cloudflared"
}

# ---------------------------------------------------------------- tham số
MODE="run"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) MODE="dry-run" ;;
    --bootstrap-current) MODE="bootstrap" ;;
    -h|--help) usage; exit 0 ;;
    *) die "tham số không nhận diện được: $1 (xem --help)" ;;
  esac
  shift
done

# ---------------------------------------------------------------- kiểm tra đầu vào
# `ALLOW_NON_ROOT` chỉ dành cho harness test (deploy/vps/tests) chạy được trên máy dev không có
# Docker. Unit systemd của production KHÔNG đặt biến này, và đặt nó cũng không mở thêm quyền gì:
# người chạy không phải root thì vẫn bị Docker từ chối ở lệnh đầu tiên.
if [ "${ALLOW_NON_ROOT:-0}" != "1" ]; then
  [ "$EUID" -eq 0 ] || die "phải chạy bằng sudo (Docker và state dir đều cần quyền root)"
fi
for cmd in git docker flock; do
  command -v "$cmd" >/dev/null 2>&1 || die "không thấy $cmd trong PATH"
done
[ -d "$REPO/.git" ] || die "không thấy git repo tại $REPO"
[ -f "$COMPOSE_FILE" ] || die "không thấy compose file: $COMPOSE_FILE"
[ -f "$ENV_FILE" ] || die "không thấy env file: $ENV_FILE"

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

# Một lượt deploy tại một thời điểm. `-n`: timer trùng nhịp thì bỏ qua, không xếp hàng.
exec 9>"$STATE_DIR/.lock"
flock -n 9 || { log "Đã có lượt deploy khác đang chạy - bỏ qua lần này."; exit 0; }

# Chạy ở MỌI lượt thật, kể cả lượt không có gì để deploy: URL tunnel đổi độc lập với nhịp deploy, và
# "không có gì mới" chính là lượt phổ biến nhất. Không chạy ở --dry-run (phải giữ đúng nghĩa "không
# ghi state") và --bootstrap-current.
if [ "$MODE" = "run" ]; then
  check_quick_tunnel
fi

# ---------------------------------------------------------------- trạng thái
LAST_SUCCESS="$(state_get last-success-sha)"
LAST_FAILED="$(state_get last-failed-sha)"

TARGET="$(git ls-remote "$GIT_URL" "refs/heads/$BRANCH" | awk '{print $1}')" ||
  die "không đọc được refs/heads/$BRANCH từ $GIT_URL"
case "$TARGET" in
  ""|*[!0-9a-f]*) die "SHA của nhánh $BRANCH không hợp lệ: '$TARGET'" ;;
esac
[ "${#TARGET}" -eq 40 ] || die "SHA của nhánh $BRANCH không phải 40 ký tự: '$TARGET'"

if [ "$MODE" = "bootstrap" ]; then
  [ -z "$LAST_SUCCESS" ] ||
    die "state đã có last-success=${LAST_SUCCESS:0:12}; không bootstrap lại (muốn đổi thì sửa state có chủ ý)"
  CURRENT="$(git_repo rev-parse HEAD)"
  git_repo cat-file -e "$CURRENT^{commit}" || die "HEAD hiện tại không phải commit hợp lệ"
  [ -z "$(git_repo status --porcelain)" ] ||
    die "working tree production đang bẩn; dọn trước khi ghi mốc bootstrap"
  state_set last-success-sha "$CURRENT"
  log "Bootstrap: ghi nhận mốc deploy hiện tại ${CURRENT:0:12}"
  history_add "$CURRENT" "bootstrap" "none"
  exit 0
fi

# Chưa có mốc thì KHÔNG tự deploy tip: lần chạy đầu tiên của timer mà nhảy thẳng lên release mới nhất
# là một sự cố production không có gì báo trước.
[ -n "$LAST_SUCCESS" ] ||
  die "chưa có mốc deploy (state trống). Chạy 'vku-auto-deploy --bootstrap-current' một lần trước khi bật timer."

if [ "$TARGET" = "$LAST_SUCCESS" ]; then
  log "Không có gì mới: $BRANCH vẫn ở ${TARGET:0:12}."
  exit 0
fi

if [ "$TARGET" = "$LAST_FAILED" ]; then
  log "SHA ${TARGET:0:12} đã thất bại trước đó - không thử lại. Push commit mới để deploy tiếp."
  exit 0
fi

[ -z "$(git_repo status --porcelain)" ] ||
  die "working tree production đang bẩn; không checkout đè lên thay đổi cục bộ"

fetch_target "$TARGET"

# ---------------------------------------------------------------- thay đổi nào chạm container nào
declare -a CHANGED=()
while IFS= read -r path; do
  [ -n "$path" ] && CHANGED+=("$path")
done < <(git_repo diff --name-only "$LAST_SUCCESS" "$TARGET")

NEED_API=0
NEED_WORKER=0
NEED_WEB=0
if [ "${#CHANGED[@]}" -eq 0 ]; then
  # Không đọc được diff (object cũ đã mất): chọn hướng an toàn là deploy lại cả ba.
  log "Cảnh báo: không tính được diff ${LAST_SUCCESS:0:12}..${TARGET:0:12}; deploy lại cả api, worker và web"
  NEED_API=1
  NEED_WORKER=1
  NEED_WEB=1
else
  map_changed_paths "${CHANGED[@]}"
fi

# Thứ tự trong mảng LÀ thứ tự `up`: api -> worker -> web.
declare -a SERVICES=()
[ "$NEED_API" -eq 1 ] && SERVICES+=(api)
[ "$NEED_WORKER" -eq 1 ] && SERVICES+=("$WORKER_SERVICE")
[ "$NEED_WEB" -eq 1 ] && SERVICES+=(web)

log "Mục tiêu ${TARGET:0:12} (từ ${LAST_SUCCESS:0:12}): ${#CHANGED[@]} file thay đổi, service cần deploy: ${SERVICES[*]:-không có}"

if [ "$MODE" = "dry-run" ]; then
  printf '%s\n' "${CHANGED[@]}" | sed 's/^/  thay đổi: /'
  log "Dry-run: không checkout, không build, không ghi state."
  exit 0
fi

# ---------------------------------------------------------------- chỉ có docs/CI: không chạm container
if [ "${#SERVICES[@]}" -eq 0 ]; then
  git_repo checkout --detach "$TARGET" >/dev/null 2>&1 || die "checkout ${TARGET:0:12} thất bại"
  state_set last-success-sha "$TARGET"
  history_add "$TARGET" "success" "none"
  log "Không có file nào ảnh hưởng container; đã tiến state sang ${TARGET:0:12}."
  exit 0
fi

# ---------------------------------------------------------------- deploy
git_repo checkout --detach "$TARGET" >/dev/null 2>&1 || die "checkout ${TARGET:0:12} thất bại"
write_override "$RUNTIME_OVERRIDE" "$TARGET" "${SERVICES[@]}"

# ---------------------------------------------------------------- preflight MinIO (ADR-028)
# Chạy sau checkout vì phải đọc compose file của chính SHA mục tiêu, và TRƯỚC `build`: dừng ở đây thì
# chưa container nào bị thay, production vẫn nguyên vẹn trên ${LAST_SUCCESS}.
#
# KHÔNG ghi `last-failed-sha`: lỗi này không nằm ở commit, mà ở một thao tác tay còn thiếu. Ghi vào đó
# sẽ khoá SHA lại cho tới khi có commit mới, trong khi cách sửa là chạy bootstrap rồi để lượt timer kế
# tiếp deploy nốt (nhật ký sẽ lặp mỗi phút cho tới lúc đó - đúng ý: stack thiếu MinIO phải ồn ào).
if [ "$NEED_API" -eq 1 ] && needs_minio && ! check_minio_bootstrap; then
  printf 'MinIO chưa bootstrap cho %s\n' "$TARGET" >"$STATE_DIR/last-failure.txt"
  history_add "$TARGET" "minio-not-bootstrapped" "${SERVICES[*]}"
  git_repo checkout --detach "$LAST_SUCCESS" >/dev/null 2>&1 ||
    log "Cảnh báo: không checkout lại được ${LAST_SUCCESS:0:12}"
  die "MinIO chưa được bootstrap nên KHÔNG thay api/worker/web (production vẫn chạy ${LAST_SUCCESS:0:12}).
   Chạy tay trên VM rồi để lượt timer sau deploy tiếp:
     sudo mkdir -p \${PROD_DATA_ROOT}/minio
     sudo docker compose --env-file $ENV_FILE -f $COMPOSE_FILE up -d minio minio-init
   Chi tiết xem docs/DEPLOYMENT.md (ADR-028)."
fi

# Compose chỉ được phép chạy tuần tự: hai build song song trên cùng VM nhỏ dễ làm healthcheck của
# lần `up` trước đó hết thời gian chờ.
export COMPOSE_PARALLEL_LIMIT=1

# Đúng hai image tồn tại trong stack: backend (`api` + worker dùng chung) và web. Worker không bao giờ
# tự đứng ra build - `build api ai-review-worker` là build lại đúng source đó lần thứ hai.
declare -a BUILD_SERVICES=()
for svc in "${SERVICES[@]}"; do
  [ "$svc" = "$WORKER_SERVICE" ] && continue
  BUILD_SERVICES+=("$svc")
done

if ! compose "$RUNTIME_OVERRIDE" build "${BUILD_SERVICES[@]}"; then
  state_set last-failed-sha "$TARGET"
  printf 'build thất bại cho %s\n' "$TARGET" >"$STATE_DIR/last-failure.txt"
  history_add "$TARGET" "build-failed" "${SERVICES[*]}"
  # Chưa container nào bị thay, nên không cần rollback - chỉ trả working tree về mốc đang chạy.
  git_repo checkout --detach "$LAST_SUCCESS" >/dev/null 2>&1 || true
  die "build ${TARGET:0:12} thất bại; production vẫn đang chạy ${LAST_SUCCESS:0:12}"
fi

# `SERVICES` đã xếp sẵn api -> worker -> web: nginx của `web` phân giải IP của `api` lúc khởi động nên
# `api` phải được tạo trước, và worker không phụ thuộc gì vào `web`.
if ! compose "$RUNTIME_OVERRIDE" up -d --no-deps --no-build --wait --wait-timeout "$WAIT_TIMEOUT" "${SERVICES[@]}"; then
  state_set last-failed-sha "$TARGET"
  printf 'up/health thất bại cho %s\n' "$TARGET" >"$STATE_DIR/last-failure.txt"
  history_add "$TARGET" "up-failed" "${SERVICES[*]}"
  # Thất bại giữa chừng vẫn phải gỡ: đánh dấu SHA lỗi TRƯỚC khi rollback để nếu rollback cũng hỏng thì
  # timer không quay lại thử cùng SHA này mỗi phút.
  do_rollback "$LAST_SUCCESS" "${SERVICES[@]}" ||
    die "deploy ${TARGET:0:12} thất bại VÀ rollback về ${LAST_SUCCESS:0:12} cũng thất bại. Cần can thiệp tay: xem $STATE_DIR/history.log và journalctl -u vku-deploy.service"
  die "deploy ${TARGET:0:12} thất bại; đã rollback về ${LAST_SUCCESS:0:12}"
fi

if ! verify_services "$RUNTIME_OVERRIDE" "$TARGET" "${SERVICES[@]}" || ! check_health "$RUNTIME_OVERRIDE"; then
  state_set last-failed-sha "$TARGET"
  printf 'revision/health không khớp cho %s\n' "$TARGET" >"$STATE_DIR/last-failure.txt"
  history_add "$TARGET" "verify-failed" "${SERVICES[*]}"
  do_rollback "$LAST_SUCCESS" "${SERVICES[@]}" ||
    die "xác minh ${TARGET:0:12} thất bại VÀ rollback về ${LAST_SUCCESS:0:12} cũng thất bại. Cần can thiệp tay: xem $STATE_DIR/history.log"
  die "xác minh ${TARGET:0:12} thất bại; đã rollback về ${LAST_SUCCESS:0:12}"
fi

state_set last-success-sha "$TARGET"
history_add "$TARGET" "success" "${SERVICES[*]}"
prune_images "$TARGET" "$LAST_SUCCESS"
log "Deploy xong ${TARGET:0:12} (${SERVICES[*]}); giữ image của ${TARGET:0:12} và ${LAST_SUCCESS:0:12}"
