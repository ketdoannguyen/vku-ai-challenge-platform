#!/usr/bin/env bash
# Cài/cập nhật cơ chế auto-deploy production: deployer + systemd unit.
#
#   sudo deploy/vps/install-auto-deploy.sh
#
# Chạy từ commit đã duyệt trên nhánh release. Script copy deployer vào /usr/local/sbin rồi mới cài
# unit, nên file trong repo không bao giờ được systemd chạy trực tiếp - một commit xấu không tự thay
# được cơ chế recovery của chính nó. Cùng lý do đó, `scripts/backup_prod.sh` được đóng băng thành
# `/usr/local/sbin/vku-backup-prod`.
#
# Script này KHÔNG bật timer. Bật timer là bước bàn giao cuối: in ở cuối để người vận hành tự chạy
# sau khi đã bootstrap và xem `--dry-run`.

set -euo pipefail

SRC_DIR="${SRC_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
REPO_DIR="${REPO_DIR:-$(cd "$SRC_DIR/../.." && pwd)}"

# Override được qua biến môi trường để kiểm thử trên thư mục tạm. Production không đặt biến nào,
# nên giá trị mặc định dưới đây chính là đích thật. (Người đặt được biến môi trường cho script này
# cũng đã phải là root để chạy nó, nên đây không phải một bề mặt tấn công mới.)
STATE_DIR="${STATE_DIR:-/var/lib/vku-deploy}"
SBIN="${SBIN:-/usr/local/sbin}"
UNIT_DIR="${UNIT_DIR:-/etc/systemd/system}"

die() { printf 'LỖI: %s\n' "$*" >&2; exit 1; }
note() { printf '%s\n' "$*"; }

[ "$EUID" -eq 0 ] || die "phải chạy bằng sudo (cần ghi vào $SBIN và $UNIT_DIR)"

DEPLOYER_SRC="$SRC_DIR/auto-deploy.sh"
SERVICE_SRC="$SRC_DIR/vku-deploy.service"
TIMER_SRC="$SRC_DIR/vku-deploy.timer"
BACKUP_SRC="$REPO_DIR/scripts/backup_prod.sh"
BACKUP_UNIT_SRC="$SRC_DIR/../vku-backup.service"

for f in "$DEPLOYER_SRC" "$SERVICE_SRC" "$TIMER_SRC" "$BACKUP_SRC" "$BACKUP_UNIT_SRC"; do
  [ -f "$f" ] || die "không thấy $f - script phải được chạy từ deploy/vps/ trong repo"
done

# In commit nguồn để lần cài này truy vết được; không phải điều kiện bắt buộc nên không fail nếu thiếu.
if rev="$(git -C "$REPO_DIR" rev-parse --short=12 HEAD 2>/dev/null)"; then
  note "Cài đặt từ $REPO_DIR @ $rev"
else
  note "Cài đặt từ $REPO_DIR (không đọc được git HEAD)"
fi

# Cài qua file tạm rồi `mv`: `install` của GNU coreutils ghi đè TẠI CHỖ (truncate rồi copy), nên nếu
# một lượt deploy đang chạy đúng lúc này, tiến trình bash đang đọc chính file đó có thể đọc phải nội
# dung đã bị cắt dở. `mv` trong cùng thư mục là rename nguyên tử, nên tiến trình đang chạy vẫn đọc
# trọn bản cũ và bản mới chỉ có hiệu lực từ lượt sau.
atomic_install() { # $1=mode $2=src $3=dest
  local tmp="$3.tmp.$$"
  install -o root -g root -m "$1" "$2" "$tmp" || { rm -f "$tmp"; die "không cài được $3"; }
  mv -f "$tmp" "$3"
}

atomic_install 0755 "$DEPLOYER_SRC" "$SBIN/vku-auto-deploy"
atomic_install 0755 "$BACKUP_SRC" "$SBIN/vku-backup-prod"
atomic_install 0644 "$SERVICE_SRC" "$UNIT_DIR/vku-deploy.service"
atomic_install 0644 "$TIMER_SRC" "$UNIT_DIR/vku-deploy.timer"

# Chỉ cập nhật unit backup khi VM đã có nó. Cài mới unit này là bật một job backup hằng ngày - việc
# không thuộc phạm vi auto-deploy, nên để người vận hành quyết định.
if [ -f "$UNIT_DIR/vku-backup.service" ]; then
  atomic_install 0644 "$BACKUP_UNIT_SRC" "$UNIT_DIR/vku-backup.service"
  note "Đã cập nhật $UNIT_DIR/vku-backup.service (ExecStart -> $SBIN/vku-backup-prod)"
else
  note "VM chưa cài vku-backup.service: đã đóng băng backup script nhưng chưa có gì gọi nó."
fi

# State dir tạo sẵn với quyền 0700: deployer chỉ `mkdir -p`, nên nếu để nó tự tạo thì thư mục sẽ theo
# umask của tiến trình chứ không theo quyền mong muốn.
install -o root -g root -m 0700 -d "$STATE_DIR"

# Verify TRƯỚC khi reload: systemd-analyze đọc file trực tiếp và cần ExecStart tồn tại, nên nó chỉ có
# nghĩa sau khi binary đã được cài ở trên. Unit hỏng phải bị bắt ở đây, không phải lúc timer chạy.
systemd-analyze verify "$UNIT_DIR/vku-deploy.service" "$UNIT_DIR/vku-deploy.timer" ||
  die "unit không hợp lệ - ĐÃ copy file nhưng chưa reload; sửa rồi chạy lại script"

systemctl daemon-reload

cat <<EOF

Đã cài xong. Chưa bật timer.

Bước tiếp theo (thủ công, theo thứ tự):
  1. sudo $SBIN/vku-auto-deploy --bootstrap-current
  2. sudo $SBIN/vku-auto-deploy --dry-run        # xem sẽ deploy gì
  3. sudo systemctl enable --now vku-deploy.timer

Timer đang bật sẵn thì không cần làm gì thêm: mỗi lượt chạy đều exec lại
$SBIN/vku-auto-deploy nên bản mới được dùng từ lượt kế tiếp.
EOF
