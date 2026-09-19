import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/react";

// `asyncUtilTimeout` mặc định 1000ms, tính cho máy rảnh. Panel markdown (`CompetitionContentPanel`)
// nạp `MarkdownView` bằng `React.lazy` + dynamic `import()`, nên lần render đầu phải chờ Vite
// transform cả nhánh module markdown. Trên 4 core chạy song song 4 vòng lặp CPU bận, test này mất
// 932-1195ms - tức mốc 1000ms rơi ngay giữa phân bố, và `findBy*` hết giờ chờ dù sản phẩm không chậm.
// Flake có thật, đã bắt được: `CompetitionDetailPage.test.tsx` fail ở 1047ms, "Unable to find role
// heading". 5000ms cho khoảng đệm ~4x so với đỉnh đo được, và vẫn là một cận có ý nghĩa - phần tử
// không bao giờ xuất hiện thì vẫn fail.
configure({ asyncUtilTimeout: 5000 });
