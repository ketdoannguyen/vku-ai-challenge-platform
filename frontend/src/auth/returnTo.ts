/** Chỉ cho phép điều hướng quay lại tới một route nội bộ cùng origin. */

export function returnToFromLocation(location: {
  pathname: string;
  search?: string;
  hash?: string;
}): string {
  return `${location.pathname}${location.search ?? ""}${location.hash ?? ""}`;
}

export function safeReturnTo(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.startsWith("/\\")
  ) {
    return "/";
  }
  return value;
}
