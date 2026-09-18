/**
 * Phân giải đường dẫn ảnh trong Markdown về endpoint asset của cuộc thi.
 *
 * Tác giả chỉ được tham chiếu ảnh đã upload của chính cuộc thi; endpoint
 * `GET /api/competitions/{slug}/assets/{name}` (`backend/app/content/router.py`) chỉ nhận một
 * tên file phẳng trong thư mục `assets/`. Helper này là nơi duy nhất biết hợp đồng đó, nên mọi
 * đường dẫn sai nguồn đều bị chặn trước khi renderer tạo request.
 */

/** Alias hợp lệ của cùng một đường dẫn canonical `assets/<name>`. */
const ASSET_ALIASES: string[] = ["assets/", "./assets/", "../assets/"];

/** Định dạng ảnh backend chấp nhận - xem `ASSET_TYPES` trong `backend/app/content/storage.py`. */
const ASSET_EXTENSION = /\.(png|jpe?g|gif|webp)$/i;

/**
 * Allowlist duy nhất cho tên file: không bắt đầu bằng dấu chấm, không `/` nên mọi thư mục con
 * và `..` đều bị loại, đồng thời loại luôn khoảng trắng, control char, `?`, `#`, `%` và `\`.
 */
const SAFE_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function resolveMarkdownAssetUrl(
  raw: string | null | undefined,
  competitionSlug: string,
): string | null {
  const value = (raw ?? "").trim();

  const alias = ASSET_ALIASES.find((prefix) => value.startsWith(prefix));
  if (alias === undefined) return null;

  const name = value.slice(alias.length);
  if (!SAFE_FILENAME.test(name) || !ASSET_EXTENSION.test(name)) return null;

  return `/api/competitions/${competitionSlug}/assets/${name}`;
}
