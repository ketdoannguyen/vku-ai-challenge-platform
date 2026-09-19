/** Phân loại hierarchy từ mdast; chỉ đọc cây Markdown, không sửa nội dung hay sinh HTML. */

export type HeadingAccent = "blue" | "red" | "yellow";
export type HeadingVisualRole = "title" | "section" | "square" | "dash" | "sub" | "label";

export type HeadingHierarchy = {
  headings: Map<number, { accent: HeadingAccent; role: HeadingVisualRole }>;
};

type MdastNode = {
  type?: string;
  depth?: number;
  children?: MdastNode[];
  position?: { start?: { offset?: number } };
};

const ACCENTS: HeadingAccent[] = ["blue", "red", "yellow"];
const SECTION_ROLES: HeadingVisualRole[] = ["section", "square", "dash", "sub", "label"];
const TITLE_ROLES: HeadingVisualRole[] = ["title", "section", "square", "dash", "sub", "label"];

/**
 * Đếm `#` ở cấp root để xác định hai chế độ:
 * - đúng một `#`: đó là title tài liệu, các cấp dưới được nâng một bậc thị giác;
 * - không có hoặc có nhiều `#`: mỗi `#` là thanh mục như bình thường.
 *
 * Offset lấy từ parser Markdown, không quét source bằng regex. Heading lồng trong quote/list không được
 * dùng để quyết định title mode, nhưng vẫn nhận vai trò và màu theo section root gần nhất.
 */
export function remarkHeadingHierarchy(hierarchy: HeadingHierarchy) {
  return (tree: MdastNode) => {
    const rootHeadings = (tree.children ?? []).filter(
      (node) => node.type === "heading" && typeof node.depth === "number",
    );
    const topLevel = rootHeadings.filter((node) => node.depth === 1);
    const titleMode = topLevel.length === 1;
    const sectionDepth = titleMode ? 2 : 1;
    const sectionOffsets = rootHeadings
      .filter((node) => node.depth === sectionDepth)
      .map((node) => node.position?.start?.offset)
      .filter((offset): offset is number => typeof offset === "number");

    hierarchy.headings.clear();

    function visit(node: MdastNode) {
      if (node.type === "heading" && typeof node.depth === "number") {
        const offset = node.position?.start?.offset;
        if (typeof offset === "number") {
          const sectionIndex = Math.max(
            0,
            sectionOffsets.findLastIndex((sectionOffset) => sectionOffset <= offset),
          );
          const role = titleMode
            ? TITLE_ROLES[Math.min(node.depth - 1, TITLE_ROLES.length - 1)]
            : SECTION_ROLES[Math.min(node.depth - 1, SECTION_ROLES.length - 1)];
          hierarchy.headings.set(offset, {
            role,
            accent: ACCENTS[sectionIndex % ACCENTS.length],
          });
        }
      }
      for (const child of node.children ?? []) visit(child);
    }

    visit(tree);
  };
}
