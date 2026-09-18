import {
  isSafeResourceUrl,
  MAX_COMPETITION_RESOURCES,
  type CompetitionResource,
} from "../api/competitions";

export type CleanCompetitionResourcesResult =
  | { ok: true; resources: CompetitionResource[] }
  | { ok: false; message: string };

const RESOURCE_LABEL_MAX = 120;

function normalizeCompetitionResources(
  resources: CompetitionResource[],
): CompetitionResource[] {
  return resources
    .map((resource) => ({
      label: resource.label.trim(),
      url: resource.url.trim(),
    }))
    .filter((resource) => resource.label !== "" || resource.url !== "");
}

/** So sánh giá trị sẽ được lưu để khoảng trắng hoặc dòng rỗng không tạo thay đổi giả. */
export function sameCompetitionResources(
  left: CompetitionResource[],
  right: CompetitionResource[],
): boolean {
  return JSON.stringify(normalizeCompetitionResources(left)) ===
    JSON.stringify(normalizeCompetitionResources(right));
}

/** Chuẩn hóa form tài nguyên và giữ validation phía client đồng nhất giữa create dialog và tab quản trị. */
export function cleanCompetitionResources(
  resources: CompetitionResource[],
): CleanCompetitionResourcesResult {
  const cleaned = normalizeCompetitionResources(resources);

  if (cleaned.length > MAX_COMPETITION_RESOURCES) {
    return {
      ok: false,
      message: `Mỗi cuộc thi tối đa ${MAX_COMPETITION_RESOURCES} tài nguyên.`,
    };
  }

  for (const resource of cleaned) {
    if (!resource.label) {
      return { ok: false, message: "Mỗi tài nguyên cần có tên." };
    }
    if (resource.label.length > RESOURCE_LABEL_MAX) {
      return {
        ok: false,
        message: `Tên tài nguyên tối đa ${RESOURCE_LABEL_MAX} ký tự.`,
      };
    }
    if (!isSafeResourceUrl(resource.url)) {
      return {
        ok: false,
        message: "Link tài nguyên phải là https://drive.google.com hoặc https://docs.google.com.",
      };
    }
  }

  return { ok: true, resources: cleaned };
}
