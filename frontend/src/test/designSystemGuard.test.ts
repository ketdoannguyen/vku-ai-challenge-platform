/**
 * Guard cấp nguồn: dự án không cài Tailwind, nên utility token kiểu Tailwind viết trong TSX
 * không khớp selector nào trong `index.css` — class chết, không có tác dụng gì về mặt hiển thị.
 * Guard quét thẳng giá trị `className` của mọi file TSX để chặn chúng quay lại.
 *
 * Phạm vi cố ý hẹp: chỉ những token trong `LEGACY_LAYOUT_TOKENS` mới bị chặn, không phải mọi
 * class lạ trong repo — đây không phải một CSS linter. Vì vậy các class không có rule CSS nào
 * (`support-faq-panel`, …) và các class trông giống Tailwind nhưng là class thật của ứng dụng
 * (`text-muted`, `sr-only`, `btn-sm`) đều không bị chặn.
 */

import { expect, test } from "vitest";

/** Token Tailwind thuần từng xuất hiện trong repo và không có định nghĩa CSS nào. */
const LEGACY_LAYOUT_TOKENS = new Set([
  "flex",
  "inline-flex",
  "items-start",
  "items-center",
  "items-end",
  "justify-start",
  "justify-center",
  "justify-between",
  "justify-end",
  "gap-1",
  "gap-1.5",
  "gap-2",
  "gap-3",
  "gap-4",
  "gap-6",
]);

const TSX_SOURCES = import.meta.glob<string>("/src/**/*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Cắt giá trị của mọi attribute `className` trong nguồn TSX. */
function classNameValues(source: string): string[] {
  const values: string[] = [];
  const attribute = /\bclassName\s*=\s*/g;
  let match = attribute.exec(source);
  while (match) {
    const start = attribute.lastIndex;
    const opener = source[start];
    if (opener === '"' || opener === "'") {
      const end = source.indexOf(opener, start + 1);
      if (end !== -1) {
        values.push(source.slice(start + 1, end));
        attribute.lastIndex = end + 1;
      }
    } else if (opener === "{") {
      let depth = 0;
      let cursor = start;
      for (; cursor < source.length; cursor += 1) {
        const char = source[cursor];
        if (char === '"' || char === "'" || char === "`") {
          // Nhảy qua cả chuỗi để dấu ngoặc bên trong không phá phép đếm độ sâu.
          const close = source.indexOf(char, cursor + 1);
          if (close === -1) break;
          cursor = close;
          continue;
        }
        if (char === "{") depth += 1;
        else if (char === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      values.push(source.slice(start + 1, cursor));
      attribute.lastIndex = cursor + 1;
    }
    match = attribute.exec(source);
  }
  return values;
}

/** Tách token class; mọi ký tự không thuộc tên class đều thành dấu cách. */
function classTokens(value: string): string[] {
  return value
    .replace(/[^A-Za-z0-9_-]+/g, " ")
    .split(" ")
    .filter(Boolean);
}

/** Các token chết tìm thấy trong một nguồn TSX. */
function legacyTokensIn(source: string): string[] {
  return classNameValues(source)
    .flatMap(classTokens)
    .filter((token) => LEGACY_LAYOUT_TOKENS.has(token));
}

test("guard quét được toàn bộ TSX trong src", () => {
  // Nếu cú pháp glob đổi mà không ai để ý, test dưới sẽ pass rỗng — chốt lại ở đây.
  expect(Object.keys(TSX_SOURCES).length).toBeGreaterThan(20);
});

test("bắt được utility chết ở cả chuỗi tĩnh, template literal và nhánh điều kiện", () => {
  const sample = [
    '<div className="card flex items-center gap-2">',
    "<div className={`row ${active ? `justify-between gap-3` : \"col\"}`}>",
  ].join("\n");
  expect(legacyTokensIn(sample)).toEqual([
    "flex",
    "items-center",
    "gap-2",
    "justify-between",
    "gap-3",
  ]);
  // Class thật của ứng dụng và class no-op có chủ đích không bị coi là vi phạm.
  expect(legacyTokensIn('<span className="text-muted sr-only btn-sm support-faq-panel" />')).toEqual(
    [],
  );
});

test("không còn utility token Tailwind chết trong className của TSX", () => {
  const violations = Object.entries(TSX_SOURCES).flatMap(([file, source]) =>
    legacyTokensIn(source).map((token) => `${file}: ${token}`),
  );
  expect(violations).toEqual([]);
});
