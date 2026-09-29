import { expect, test } from "vitest";
import { SUBMISSION_PITFALLS, submissionSchema } from "./submissionRequirements";

test("cuộc thi v2 dùng đúng cột và kiểu dữ liệu admin khai báo", () => {
  const schema = submissionSchema({
    id_column: "sample_id",
    columns: [
      { name: "sample_id", type: "integer", nullable: false, allowed_values: null },
      { name: "predict_label", type: "integer", nullable: false, allowed_values: [0, 1] },
      { name: "predict_type", type: "integer", nullable: false, allowed_values: [0, 1, 2] },
    ],
  });

  expect(schema.idColumn).toBe("sample_id");
  expect(schema.columns.map((column) => column.name)).toEqual([
    "sample_id",
    "predict_label",
    "predict_type",
  ]);
  // Ô mẫu phải hợp lệ với schema: ID đếm tăng, cột enum lặp theo danh sách giá trị cho phép.
  expect(schema.rows).toEqual([
    ["1", "0", "0"],
    ["2", "1", "1"],
    ["3", "0", "2"],
    ["4", "1", "0"],
  ]);
});

test("cột chuỗi không khai báo enum sinh mẫu đọc được, ID vẫn theo dạng sample_0001", () => {
  const schema = submissionSchema({
    id_column: "id",
    columns: [
      { name: "id", type: "string", nullable: false, allowed_values: null },
      { name: "answer", type: "string", nullable: true, allowed_values: null },
      { name: "score", type: "number", nullable: true, allowed_values: null },
    ],
  });

  expect(schema.rows).toEqual([
    ["sample_0001", "text_1", "0.5"],
    ["sample_0002", "text_2", "1.5"],
    ["sample_0003", "text_3", "2.5"],
    ["sample_0004", "text_4", "3.5"],
  ]);
});

test("cuộc thi v1 chưa khai báo schema rơi về hai cột cố định của bộ chấm sklearn", () => {
  const schema = submissionSchema({ id_column: "record_id", prediction_column: "label" });
  expect(schema.columns.map((column) => column.name)).toEqual(["record_id", "label"]);
  expect(schema.rows).toEqual([
    ["sample_0001", "1"],
    ["sample_0002", "0"],
    ["sample_0003", "0"],
    ["sample_0004", "1"],
  ]);
});

test("cấu hình thiếu hoặc rỗng rơi về mặc định, không hở null ra UI", () => {
  const fallback = ["id", "prediction"];
  for (const config of [
    null,
    undefined,
    { id_column: null, prediction_column: null },
    // Khoảng trắng cũng là "chưa cấu hình" - nếu không cắt, tên cột sẽ thành chuỗi trắng.
    { id_column: "  ", prediction_column: "  " },
  ]) {
    expect(submissionSchema(config).columns.map((column) => column.name)).toEqual(fallback);
  }
  expect(
    submissionSchema({ id_column: " record_id ", prediction_column: " label " }).columns.map(
      (column) => column.name,
    ),
  ).toEqual(["record_id", "label"]);
});

test("mọi lỗi thường gặp đều có mã và mô tả đọc được", () => {
  const schema = submissionSchema({ id_column: "record_id", prediction_column: "label" });
  for (const pitfall of SUBMISSION_PITFALLS) {
    expect(pitfall.code).toMatch(/^[A-Z_]+$/);
    expect(pitfall.description(schema).length).toBeGreaterThan(0);
  }
  // Chỉ lỗi do giá trị trong ô mang tone cảnh báo; phần còn lại là lỗi cấu trúc tệp.
  expect(SUBMISSION_PITFALLS.filter((pitfall) => pitfall.tone === "warning").map((pitfall) => pitfall.code)).toEqual([
    "SUBMISSION_VALUE_INVALID",
  ]);
});
