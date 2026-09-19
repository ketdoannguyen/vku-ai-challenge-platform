/**
 * Thông tin chính thức dùng chung cho hai trang tĩnh `/gioi-thieu` và `/ho-tro`.
 * Mọi dữ kiện về VKU đều khai ở đây; đổi thông tin thì sửa file này, không sửa trong JSX.
 */

export const VKU_NAME =
  "Trường Đại học Công nghệ Thông tin và Truyền thông Việt - Hàn, Đại học Đà Nẵng";
export const VKU_ADDRESS =
  "Khu đô thị Đại học Đà Nẵng, 470 Đường Trần Đại Nghĩa, Phường Ngũ Hành Sơn, Thành phố Đà Nẵng";
export const VKU_EMAIL = "info@vku.udn.vn";
export const VKU_PHONE = "0236 3 667 117";
export const VKU_PHONE_HREF = "tel:+842363667117";
export const VKU_SITE = "https://vku.udn.vn/";

export const KHCN_HTQT_NAME = "Phòng Khoa học Công nghệ - Hợp tác Quốc tế";
export const KHCN_HTQT_EMAIL = "khcn_htqt@vku.udn.vn";
export const KHCN_HTQT_PHONE = "0236.3.962.972";
export const KHCN_HTQT_PHONE_HREF = "tel:+842363962972";

/** Đầu mối hỗ trợ kỹ thuật nền tảng - thông tin do người dùng trực tiếp uỷ quyền công bố. */
export const PLATFORM_SUPPORT_NAME = "Nguyễn Kết Đoàn";
export const PLATFORM_SUPPORT_EMAIL = "nkdoan@vku.udn.vn";
export const PLATFORM_SUPPORT_PHONE = "0396090576";
export const PLATFORM_SUPPORT_PHONE_HREF = "tel:+84396090576";

/**
 * Trang giới thiệu đơn vị chủ trì trên site VKU. Đây là nguồn ngoài duy nhất còn lại sau ADR-024:
 * danh mục "Nguồn thông tin" ở `/gioi-thieu` đã bị bỏ nên ba URL còn lại không còn nơi hiển thị.
 */
export const VKU_DEPARTMENT_URL =
  "https://vku.udn.vn/vi/co-cau-to-chuc/phong-khoa-hoc-cong-nghe-hop-tac-quoc-te/";
