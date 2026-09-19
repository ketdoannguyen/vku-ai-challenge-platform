/** Slugify: tiếng Việt có dấu, "đ", ký tự lạ và trần ký tự của backend. */

import { expect, test } from "vitest";
import { SLUG_MAX, slugify } from "./slug";

test("bỏ dấu tiếng Việt, thay đ và hạ chữ thường", () => {
  expect(slugify("Đề bài số 1")).toBe("de-bai-so-1");
  expect(slugify("Cuộc thi AI 2026")).toBe("cuoc-thi-ai-2026");
});

test("ký tự lạ gom thành một gạch ngang, không để gạch ở hai đầu", () => {
  expect(slugify("  F1-Score: (v2)  ")).toBe("f1-score-v2");
  expect(slugify("Cuộc thi 🎉")).toBe("cuoc-thi");
  expect(slugify("___")).toBe("");
  expect(slugify("")).toBe("");
});

test("cắt còn SLUG_MAX ký tự và bỏ gạch ngang cuối do cắt cụt", () => {
  const full = slugify("a".repeat(SLUG_MAX) + " b");
  expect(full).toBe("a".repeat(SLUG_MAX));

  // Cắt đúng vào chỗ nối: gạch ngang cuối bị bỏ nên slug ngắn hơn trần một ký tự.
  const cut = slugify("a".repeat(SLUG_MAX - 1) + " bc");
  expect(cut).toBe("a".repeat(SLUG_MAX - 1));
});

test("kết quả luôn khớp ràng buộc slug của backend", () => {
  for (const text of ["Đề bài số 1", "F1-Score: (v2)", "Cuộc thi AI 2026 🎉"]) {
    expect(slugify(text)).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  }
});
