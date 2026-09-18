import { describe, expect, it } from "vitest";
import { returnToFromLocation, safeReturnTo } from "./returnTo";

describe("returnTo", () => {
  it("giữ nguyên pathname, query và hash nội bộ", () => {
    expect(
      returnToFromLocation({
        pathname: "/competitions/ai-cup",
        search: "?page=2",
        hash: "#leaderboard",
      }),
    ).toBe("/competitions/ai-cup?page=2#leaderboard");
    expect(safeReturnTo("/competitions/ai-cup?page=2#leaderboard")).toBe(
      "/competitions/ai-cup?page=2#leaderboard",
    );
  });

  it.each([undefined, null, "", "https://evil.example", "//evil.example", "/\\evil.example", 123])(
    "đưa return-to không an toàn %j về trang chủ",
    (value) => {
      expect(safeReturnTo(value)).toBe("/");
    },
  );
});
