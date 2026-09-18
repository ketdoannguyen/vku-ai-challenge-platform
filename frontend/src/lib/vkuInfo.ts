/**
 * Thông tin chính thức dùng chung cho hai trang tĩnh `/gioi-thieu` và `/ho-tro`.
 * Mọi dữ kiện về VKU lấy từ `VKU_SOURCES`; đổi thông tin thì sửa ở đây, không sửa trong JSX.
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

/** Nhãn nguồn cố ý ngắn (2–6 chữ) thay vì dán URL dài; domain đã thể hiện qua `target="_blank"`. */
export type VkuSource = { label: string; url: string };

export const VKU_SOURCES: { about: VkuSource; contact: VkuSource; department: VkuSource; udn: VkuSource } =
  {
    about: {
      label: "Giới thiệu Trường",
      url: "https://vku.udn.vn/gioi-thieu",
    },
    contact: {
      label: "Liên hệ",
      url: "https://vku.udn.vn/lien-he",
    },
    department: {
      label: "Phòng KHCN - Hợp tác Quốc tế",
      url: "https://vku.udn.vn/vi/co-cau-to-chuc/phong-khoa-hoc-cong-nghe-hop-tac-quoc-te/",
    },
    udn: {
      label: "Đại học Đà Nẵng",
      url: "https://udn.vn/",
    },
  };
