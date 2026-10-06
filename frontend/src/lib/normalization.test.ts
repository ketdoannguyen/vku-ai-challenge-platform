import { expect, test } from "vitest";
import { cleanNormalization } from "./normalization";

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
