import { expect, test } from "vitest";
import {
  cleanNormalization,
  currentNormHiddenReason,
  hiddenNormNote,
  NORM_HIDDEN_BY_LEADERBOARD_NOTE,
  NORM_HIDDEN_BY_METRIC_NOTE,
  type NormVisibilitySource,
} from "./normalization";

/** DTO tối thiểu đủ để phán quyết; mặc định là norm đang xem được. */
function source(overrides: Partial<NormVisibilitySource> = {}): NormVisibilitySource {
  return {
    leaderboard_visible: true,
    primary_metric_label: "F1",
    normalization: { enabled: true, baseline: 0.5, version: 1 },
    ...overrides,
  };
}

test("tắt chuẩn hóa thì bỏ hẳn baseline", () => {
  expect(cleanNormalization(false, "0.6")).toEqual({
    ok: true,
    normalization: { enabled: false, baseline: null },
  });
});

test("bật chuẩn hóa nhận baseline hữu hạn, kể cả 0 và số âm", () => {
  expect(cleanNormalization(true, " 0.6 ")).toEqual({
    ok: true,
    normalization: { enabled: true, baseline: 0.6 },
  });
  expect(cleanNormalization(true, "0")).toEqual({
    ok: true,
    normalization: { enabled: true, baseline: 0 },
  });
  expect(cleanNormalization(true, "-2.5")).toEqual({
    ok: true,
    normalization: { enabled: true, baseline: -2.5 },
  });
});

test("bật chuẩn hóa từ chối baseline trống hoặc không hữu hạn", () => {
  for (const input of ["", "   ", "abc", "1e999"]) {
    expect(cleanNormalization(true, input)).toEqual({
      ok: false,
      message: "Bật chuẩn hóa cần baseline là số hữu hạn.",
    });
  }
});

test("single đủ bốn điều kiện thì norm đang xem được", () => {
  expect(currentNormHiddenReason(source(), null)).toBeNull();
});

test("single thiếu điều kiện nào trả đúng lý do điều kiện đó", () => {
  // N: master tắt hẳn - lý do này đứng trước cả BXH và metric.
  expect(
    currentNormHiddenReason(
      source({
        normalization: { enabled: false, baseline: null, version: 1 },
        leaderboard_visible: false,
        primary_metric_label: null,
      }),
      null,
    ),
  ).toBe("normalization_disabled");
  // L: BXH bị ẩn dù cuộc thi vẫn bật chuẩn hóa.
  expect(currentNormHiddenReason(source({ leaderboard_visible: false }), null)).toBe(
    "leaderboard_hidden",
  );
  // M: metric nguồn bị ẩn theo cấu hình hiển thị điểm.
  expect(currentNormHiddenReason(source({ primary_metric_label: null }), null)).toBe(
    "source_metric_hidden",
  );
  // Response cũ chưa có `normalization` được coi là chưa bật, không đoán là đang bật.
  expect(currentNormHiddenReason({ leaderboard_visible: true, primary_metric_label: "F1" }, null)).toBe(
    "normalization_disabled",
  );
});

test("dual phán quyết theo capability của đúng nhánh", () => {
  const competition = source({
    mode: "public_private",
    tracks: {
      public: { normalization_visible: false, normalization_hidden_reason: "private_unpublished" },
      private: { normalization_visible: true, normalization_hidden_reason: null },
    },
  });
  // Nhánh Private: capability quyết định, không suy lại từ các field cấp cuộc thi.
  expect(currentNormHiddenReason(competition, "private")).toBeNull();
  expect(currentNormHiddenReason(competition, "public")).toBe("private_unpublished");
});

test("dual chưa chọn nhánh hoặc response cũ thiếu capability thì không phán quyết", () => {
  const legacy = source({
    mode: "public_private",
    tracks: { public: {}, private: {} },
  });
  // Nhánh đang chọn chưa biết: nơi gọi phải giữ hành vi theo payload backend đã lọc.
  expect(currentNormHiddenReason(legacy, "private")).toBeUndefined();
  expect(currentNormHiddenReason(legacy, null)).toBeUndefined();
  // Response mới nhưng chưa chọn nhánh cũng không được đoán bừa.
  expect(
    currentNormHiddenReason(
      source({
        mode: "public_private",
        tracks: {
          public: { normalization_visible: true, normalization_hidden_reason: null },
          private: { normalization_visible: true, normalization_hidden_reason: null },
        },
      }),
      null,
    ),
  ).toBeUndefined();
});

test("chỉ hai lý do có câu giải thích riêng, dùng đúng nguyên văn", () => {
  expect(hiddenNormNote("leaderboard_hidden")).toBe(NORM_HIDDEN_BY_LEADERBOARD_NOTE);
  expect(hiddenNormNote("leaderboard_hidden")).toBe(
    "BXH đang được BTC ẩn; điểm chuẩn hóa chưa được hiển thị",
  );
  expect(hiddenNormNote("source_metric_hidden")).toBe(NORM_HIDDEN_BY_METRIC_NOTE);
  expect(hiddenNormNote("source_metric_hidden")).toBe(
    "Điểm chuẩn hóa bị ẩn theo cấu hình hiển thị điểm",
  );
  // Nhánh chưa công bố và cuộc thi không bật chuẩn hóa đã có câu riêng ở nơi hiển thị.
  expect(hiddenNormNote("private_unpublished")).toBeNull();
  expect(hiddenNormNote("normalization_disabled")).toBeNull();
  expect(hiddenNormNote(null)).toBeNull();
  expect(hiddenNormNote(undefined)).toBeNull();
});
