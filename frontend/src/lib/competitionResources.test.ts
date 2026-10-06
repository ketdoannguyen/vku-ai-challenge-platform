import { expect, test } from "vitest";
import { MAX_COMPETITION_RESOURCES } from "../api/competitions";
import {
  cleanCompetitionResources,
  sameCompetitionResources,
} from "./competitionResources";

test("chuẩn hóa tài nguyên: trim giá trị và bỏ dòng trống hoàn toàn", () => {
  expect(
    cleanCompetitionResources([
      { label: "  Dataset  ", url: "  https://drive.google.com/file/d/abc  " },
      { label: "  ", url: " " },
    ]),
  ).toEqual({
    ok: true,
    resources: [{ label: "Dataset", url: "https://drive.google.com/file/d/abc" }],
  });
});

test("so sánh theo giá trị chuẩn hóa để bỏ qua khoảng trắng và dòng rỗng", () => {
  expect(
    sameCompetitionResources(
      [{ label: " Dataset ", url: " https://drive.google.com/file/d/abc " }],
      [
        { label: "Dataset", url: "https://drive.google.com/file/d/abc" },
        { label: "", url: "" },
      ],
    ),
  ).toBe(true);
});

test("từ chối tài nguyên thiếu tên hoặc link không phải https", () => {
  expect(
    cleanCompetitionResources([{ label: "", url: "https://drive.google.com/file/d/abc" }]),
  ).toEqual({ ok: false, message: "Mỗi tài nguyên cần có tên." });

  expect(
    cleanCompetitionResources([{ label: "Dataset", url: "http://example.com/data.csv" }]),
  ).toEqual({
    ok: false,
    message: "Link tài nguyên phải là URL https hợp lệ.",
  });
});

test("nhận link tài nguyên ngoài Google Drive/Docs (S3, máy chủ riêng)", () => {
  expect(
    cleanCompetitionResources([
      { label: "Dataset S3", url: "https://bucket.s3.amazonaws.com/btc/dataset.zip" },
      { label: "Test", url: "https://example.com/data.csv" },
    ]),
  ).toEqual({
    ok: true,
    resources: [
      { label: "Dataset S3", url: "https://bucket.s3.amazonaws.com/btc/dataset.zip" },
      { label: "Test", url: "https://example.com/data.csv" },
    ],
  });
});

test("từ chối tên tài nguyên vượt quá giới hạn backend", () => {
  expect(
    cleanCompetitionResources([
      {
        label: "x".repeat(121),
        url: "https://drive.google.com/file/d/abc",
      },
    ]),
  ).toEqual({
    ok: false,
    message: "Tên tài nguyên tối đa 120 ký tự.",
  });
});

test("từ chối danh sách vượt quá giới hạn", () => {
  const resources = Array.from({ length: MAX_COMPETITION_RESOURCES + 1 }, (_, index) => ({
    label: `Tài nguyên ${index + 1}`,
    url: `https://drive.google.com/file/d/${index + 1}`,
  }));

  expect(cleanCompetitionResources(resources)).toEqual({
    ok: false,
    message: `Mỗi cuộc thi tối đa ${MAX_COMPETITION_RESOURCES} tài nguyên.`,
  });
});
