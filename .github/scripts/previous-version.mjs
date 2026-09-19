// Lấy Worker Version đang nhận traffic TRƯỚC khi deploy, để `wrangler rollback` nhắm đúng version.
//
// Script này cố ý KHÔNG fail job. Response của `wrangler deployments status --json` là dữ liệu
// Cloudflare có thể đổi shape, và một parser đoán sai sẽ chặn mọi deploy trong khi production vẫn
// khoẻ. Khi không xác định được version (chưa có deploy nào, shape lạ, traffic bị chia), script
// ghi warning rồi để trống output - workflow khi đó rollback bằng chế độ mặc định của Wrangler
// thay vì đoán một ID.

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

function warn(message) {
  console.log(`::warning::${message}`);
}

function writeVersion(version) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  appendFileSync(file, `version=${version}\n`);
}

/** Lấy object JSON đầu tiên trong stdout: wrangler có thể in banner trước payload. */
function extractJson(stdout) {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(stdout.slice(start, end + 1));
  } catch {
    return null;
  }
}

const result = spawnSync("npx", ["wrangler", "deployments", "status", "--json"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

if (result.status !== 0) {
  warn(`Không đọc được \`deployments status\` (exit ${result.status}); rollback tự động dùng mặc định của Wrangler.`);
  writeVersion("");
} else {
  const status = extractJson(result.stdout);
  const versions = Array.isArray(status?.versions) ? status.versions : [];

  if (versions.length === 0) {
    warn("Worker chưa có version nào (hoặc response không có `versions`); đây có thể là deploy đầu tiên nên không có gì để rollback.");
    writeVersion("");
  } else {
    // Version API không chia traffic, nên thiếu `percentage` được coi là 100%.
    const active = versions.filter((entry) => (entry?.percentage ?? 100) === 100);
    if (active.length !== 1) {
      warn(`Có ${active.length} version nhận 100% traffic; không đoán rollback target. Rollback (nếu cần) sẽ dùng mặc định của Wrangler.`);
      writeVersion("");
    } else {
      const id = active[0]?.version_id ?? active[0]?.id ?? "";
      if (id === "") {
        warn("Version đang nhận traffic không có trường `version_id`/`id`; rollback tự động dùng mặc định của Wrangler.");
        writeVersion("");
      } else {
        console.log(`Version đang nhận traffic trước deploy: ${id}`);
        writeVersion(id);
      }
    }
  }
}
