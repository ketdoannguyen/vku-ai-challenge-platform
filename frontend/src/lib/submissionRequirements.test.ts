import { expect, test } from "vitest";
import { SUBMISSION_PITFALLS, submissionColumns } from "./submissionRequirements";

test("cấu hình đầy đủ thì dùng đúng tên cột của cuộc thi", () => {
  expect(
    submissionColumns({ id_column: "record_id", prediction_column: "label" }),
  ).toEqual({ id: "record_id", prediction: "label" });
});

test("cấu hình thiếu hoặc rỗng rơi về mặc định, không hở null ra UI", () => {
  const fallback = { id: "id", prediction: "prediction" };
  expect(submissionColumns(null)).toEqual(fallback);
  expect(submissionColumns(undefined)).toEqual(fallback);
  expect(submissionColumns({ id_column: null, prediction_column: null })).toEqual(fallback);
  // Khoảng trắng cũng là "chưa cấu hình" - nếu không cắt, tên cột sẽ thành chuỗi trắng.
  expect(submissionColumns({ id_column: "  ", prediction_column: "  " })).toEqual(fallback);
  expect(submissionColumns({ id_column: " record_id ", prediction_column: " label " })).toEqual({
    id: "record_id",
    prediction: "label",
  });
});

test("mọi lỗi thường gặp đều có mã và mô tả đọc được", () => {
  const columns = submissionColumns({ id_column: "record_id", prediction_column: "label" });
  for (const pitfall of SUBMISSION_PITFALLS) {
    expect(pitfall.code).toMatch(/^[A-Z_]+$/);
    expect(pitfall.description(columns).length).toBeGreaterThan(0);
  }
  // Chỉ lỗi do giá trị dự đoán mang tone cảnh báo; phần còn lại là lỗi cấu trúc tệp.
  expect(SUBMISSION_PITFALLS.filter((p) => p.tone === "warning").map((p) => p.code)).toEqual([
    "VALUE_OUT_OF_RANGE",
  ]);
});
