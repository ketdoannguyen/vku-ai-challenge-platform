import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { ErrorBox } from "./ui";

test("không hiển thị error box khi chưa có lỗi", () => {
  render(<ErrorBox error={null} />);

  expect(screen.queryByRole("alert")).toBeNull();
});

test("hiển thị message của Error", () => {
  render(<ErrorBox error={new Error("Không tải được dữ liệu.")} />);

  expect(screen.getByRole("alert")).toHaveTextContent("Không tải được dữ liệu.");
});
