/** Trang tĩnh công khai: hướng dẫn tham gia, FAQ dạng accordion và ba đầu mối liên hệ chính thức. */

import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import {
  KHCN_HTQT_EMAIL,
  KHCN_HTQT_NAME,
  KHCN_HTQT_PHONE,
  KHCN_HTQT_PHONE_HREF,
  PLATFORM_SUPPORT_EMAIL,
  PLATFORM_SUPPORT_NAME,
  PLATFORM_SUPPORT_PHONE,
  PLATFORM_SUPPORT_PHONE_HREF,
  VKU_ADDRESS,
  VKU_EMAIL,
  VKU_NAME,
  VKU_PHONE,
  VKU_PHONE_HREF,
  VKU_SITE,
  VKU_SOURCES,
} from "../lib/vkuInfo";

/** Icon SVG inline dùng chung trong trang; luôn là trang trí nên ẩn khỏi cây trợ năng. */
function Icon({
  children,
  size = 18,
  strokeWidth = 1.75,
}: {
  children: ReactNode;
  size?: number;
  strokeWidth?: number;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

function IconLifeBuoy({ size }: { size: number }) {
  return (
    <Icon size={size} strokeWidth={1.6}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3.5" />
      <path d="m5.6 5.6 3.9 3.9m5 5 3.9 3.9m0-12.8-3.9 3.9m-5 5-3.9 3.9" />
    </Icon>
  );
}

function IconBookOpen() {
  return (
    <Icon>
      <path d="M12 6.5C10.5 5.2 8.6 4.5 6 4.5H4v13h2c2.6 0 4.5.7 6 2 1.5-1.3 3.4-2 6-2h2v-13h-2c-2.6 0-4.5.7-6 2Z" />
      <path d="M12 6.5v13" />
    </Icon>
  );
}

function IconHeadset() {
  return (
    <Icon>
      <path d="M4 13a8 8 0 0 1 16 0" />
      <path d="M4 13h2.5a1 1 0 0 1 1 1v3.5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V13Z" />
      <path d="M20 13h-2.5a1 1 0 0 0-1 1v3.5a1 1 0 0 0 1 1H19a1 1 0 0 0 1-1V13Z" />
    </Icon>
  );
}

function IconHelp() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.6 9.4a2.5 2.5 0 1 1 3.3 2.4c-.6.2-.9.7-.9 1.3v.3" />
      <path d="M12 16.6h.01" />
    </Icon>
  );
}

function IconMail() {
  return (
    <Icon size={14}>
      <rect x="3" y="5.5" width="18" height="13" rx="2.5" />
      <path d="m4 8.5 8 5 8-5" />
    </Icon>
  );
}

function IconPhone() {
  return (
    <Icon size={14}>
      <path d="M6.5 4h3l1.5 4-2 1.5a11.5 11.5 0 0 0 5.5 5.5l1.5-2 4 1.5v3a2 2 0 0 1-2.2 2A15.6 15.6 0 0 1 4.5 6.2 2 2 0 0 1 6.5 4Z" />
    </Icon>
  );
}

function IconGlobe() {
  return (
    <Icon size={14}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3.5 9.5h17m-17 5h17" />
      <path d="M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3Z" />
    </Icon>
  );
}

type GuideStep = { title: string; body: ReactNode };

/** Nhịp màu trang trí cho timeline; xoay vòng theo thứ tự bước, không mang nghĩa nghiệp vụ. */
const STEP_TONES = ["blue", "red", "yellow"] as const;

const GUIDE_STEPS: GuideStep[] = [
  {
    title: "Đăng nhập",
    body: <>Dùng tài khoản do Ban Tổ chức cấp để đăng nhập tại trang Đăng nhập.</>,
  },
  {
    title: "Chọn cuộc thi",
    body: (
      <>
        Danh sách cuộc thi đọc công khai ở trang <Link to="/">Cuộc thi</Link>.
      </>
    ),
  },
  {
    title: "Tham gia cuộc thi",
    body: (
      <>
        Chế độ tham gia tuỳ từng cuộc thi: mở tự do, cần mã do Ban Tổ chức cấp hoặc chỉ theo lời
        mời. Tham gia được từ khi cuộc thi được công bố đến hết thời gian thi.
      </>
    ),
  },
  {
    title: "Đọc đề bài",
    body: <>Thể lệ, đề bài và tài nguyên tải về nằm trong trang chi tiết của từng cuộc thi.</>,
  },
  {
    title: "Nộp bài",
    body: (
      <>
        Nộp bài CSV theo đúng cột dữ liệu và hạn mức mà Ban Tổ chức cấu hình cho cuộc thi.
      </>
    ),
  },
  {
    title: "Theo dõi kết quả",
    body: <>Xem lại bài đã nộp và bảng xếp hạng của cuộc thi (nếu được công khai).</>,
  },
];

type FaqItem = { id: string; question: string; answer: ReactNode };

const FAQ_ITEMS: FaqItem[] = [
  {
    id: "tai-khoan",
    question: "Tôi chưa có tài khoản thì làm sao?",
    answer: (
      <>
        Nền tảng không có chức năng tự đăng ký. Liên hệ Ban Tổ chức cuộc thi hoặc đầu mối hỗ trợ
        bên dưới để được cấp tài khoản.
      </>
    ),
  },
  {
    id: "mat-khau",
    question: "Quên mật khẩu thì làm sao?",
    answer: (
      <>
        Nền tảng không có chức năng tự đặt lại mật khẩu; quản trị viên đặt lại mật khẩu giúp bạn
        sau khi bạn liên hệ Ban Tổ chức.
      </>
    ),
  },
  {
    id: "khong-tham-gia-duoc",
    question: "Vì sao tôi không tham gia được cuộc thi?",
    answer: (
      <>
        Cuộc thi có thể đã đóng hoặc đã quá hạn tham gia, cuộc thi có thể yêu cầu mã do Ban Tổ chức
        cấp, hoặc quyền tham gia đang bị vô hiệu hoá sau khi bạn rời cuộc thi — khi đó cần Ban Tổ
        chức kích hoạt lại.
      </>
    ),
  },
  {
    id: "khong-nop-duoc",
    question: "Vì sao tôi không nộp được bài?",
    answer: (
      <>
        Các nguyên nhân thường gặp: chưa đăng nhập, chưa tham gia cuộc thi, quyền tham gia đã bị vô
        hiệu hoá, đã dùng hết lượt nộp trong ngày, cuộc thi chưa sẵn sàng chấm điểm, hoặc tệp không
        đúng định dạng mà Ban Tổ chức cấu hình.
      </>
    ),
  },
  {
    id: "han-muc",
    question: "Hạn mức nộp bài tính thế nào?",
    answer: (
      <>
        Mỗi cuộc thi giới hạn số lượt nộp mỗi ngày. Trang chi tiết cuộc thi hiển thị số lượt còn
        lại; khi hết lượt, bạn chờ sang ngày kế tiếp (theo giờ UTC).
      </>
    ),
  },
  {
    id: "dinh-dang",
    question: "Bài nộp cần định dạng nào?",
    answer: (
      <>
        Tệp phải là CSV theo đúng cột ID và cột dự đoán mà Ban Tổ chức cấu hình, dung lượng không
        vượt quá giới hạn của nền tảng. Tệp sai định dạng bị từ chối và không được tính vào hạn mức.
      </>
    ),
  },
  {
    id: "diem-xep-hang",
    question: "Điểm và bảng xếp hạng xem ở đâu?",
    answer: (
      <>
        Điểm được tính sau khi bài nộp được chấm xong; bảng xếp hạng chỉ hiển thị khi Ban Tổ chức
        công khai.
      </>
    ),
  },
  {
    id: "roi-cuoc-thi",
    question: "Tôi muốn rời cuộc thi?",
    answer: (
      <>
        Dùng nút rời ở trang chi tiết cuộc thi. Bài nộp và điểm đã có vẫn được giữ, nhưng muốn tham
        gia lại thì cần Ban Tổ chức kích hoạt.
      </>
    ),
  },
  {
    id: "to-chuc-cuoc-thi",
    question: "Tôi muốn tổ chức cuộc thi trên nền tảng?",
    answer: <>Liên hệ {KHCN_HTQT_NAME} hoặc đầu mối hỗ trợ kỹ thuật bên dưới để được hướng dẫn.</>,
  },
];

/** Chip hành động trong khối Liên hệ: email/điện thoại mở tại chỗ, website mở tab mới an toàn. */
function Chip({
  href,
  icon,
  external = false,
  children,
}: {
  href: string;
  icon: ReactNode;
  external?: boolean;
  children: ReactNode;
}) {
  return (
    <a
      className="support-chip"
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer nofollow" : undefined}
    >
      {icon}
      {children}
    </a>
  );
}

export function SupportPage() {
  useDocumentTitle("Hỗ trợ & Liên hệ");
  // Accordion một-mở: mở mục khác thì mục cũ tự đóng, bấm lại thì đóng hết.
  const [openFaqId, setOpenFaqId] = useState<string | null>(null);

  return (
    <div className="support-page">
      <header className="support-hero">
        <span className="support-hero-icon">
          <IconLifeBuoy size={28} />
        </span>
        <div className="support-hero-copy">
          <h1 className="support-title">Hỗ trợ &amp; Liên hệ</h1>
          <p className="support-subtitle">
            Cách tham gia một cuộc thi, các câu hỏi thường gặp và đầu mối liên hệ chính thức.
          </p>
          <div className="support-accent">
            <span />
            <span />
            <span />
          </div>
        </div>
      </header>

      <div className="support-grid">
        <section className="support-card support-guide" aria-labelledby="support-guide-title">
          <div className="support-card-head">
            <span className="support-card-icon support-card-icon-blue">
              <IconBookOpen />
            </span>
            <div className="support-card-copy">
              <h2 className="support-card-title" id="support-guide-title">
                Các bước tham gia
              </h2>
              <p className="support-card-sub">
                Sáu bước từ lúc đăng nhập tới khi xem kết quả.
              </p>
            </div>
          </div>

          <ol className="support-timeline">
            {GUIDE_STEPS.map((step, index) => (
              <li className="support-step" key={step.title} data-tone={STEP_TONES[index % 3]}>
                <span className="support-step-marker" aria-hidden="true">
                  {index + 1}
                </span>
                <div className="support-step-body">
                  <h3 className="support-step-title">{step.title}</h3>
                  <p className="support-step-text">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="support-card support-contact" aria-labelledby="support-contact-title">
          <div className="support-card-head">
            <span className="support-card-icon support-card-icon-blue">
              <IconHeadset />
            </span>
            <div className="support-card-copy">
              <h2 className="support-card-title" id="support-contact-title">
                Liên hệ
              </h2>
              <p className="support-card-sub">Ba đầu mối chính thức, theo thứ tự ưu tiên.</p>
            </div>
          </div>

          <ul className="support-contact-list">
            <li className="support-contact-item">
              <h3 className="support-contact-title">{VKU_NAME}</h3>
              <p className="support-contact-text">Đơn vị chủ trì. Địa chỉ: {VKU_ADDRESS}.</p>
              <div className="support-contact-actions">
                <Chip href={`mailto:${VKU_EMAIL}`} icon={<IconMail />}>
                  {VKU_EMAIL}
                </Chip>
                <Chip href={VKU_PHONE_HREF} icon={<IconPhone />}>
                  {VKU_PHONE}
                </Chip>
                <Chip href={VKU_SITE} icon={<IconGlobe />} external>
                  vku.udn.vn
                </Chip>
              </div>
            </li>
            <li className="support-contact-item">
              <h3 className="support-contact-title">{KHCN_HTQT_NAME}</h3>
              <p className="support-contact-text">
                Đầu mối về hoạt động khoa học công nghệ và hợp tác quốc tế của Trường.
              </p>
              <div className="support-contact-actions">
                <Chip href={`mailto:${KHCN_HTQT_EMAIL}`} icon={<IconMail />}>
                  {KHCN_HTQT_EMAIL}
                </Chip>
                <Chip href={KHCN_HTQT_PHONE_HREF} icon={<IconPhone />}>
                  {KHCN_HTQT_PHONE}
                </Chip>
                <Chip href={VKU_SOURCES.department.url} icon={<IconGlobe />} external>
                  Trang đơn vị
                </Chip>
              </div>
            </li>
            <li className="support-contact-item">
              <h3 className="support-contact-title">Hỗ trợ kỹ thuật nền tảng</h3>
              <p className="support-contact-text">
                {PLATFORM_SUPPORT_NAME} — tài khoản, đăng nhập và các sự cố khi dùng hệ thống.
              </p>
              <div className="support-contact-actions">
                <Chip href={`mailto:${PLATFORM_SUPPORT_EMAIL}`} icon={<IconMail />}>
                  {PLATFORM_SUPPORT_EMAIL}
                </Chip>
                <Chip href={PLATFORM_SUPPORT_PHONE_HREF} icon={<IconPhone />}>
                  {PLATFORM_SUPPORT_PHONE}
                </Chip>
              </div>
            </li>
          </ul>

          <p className="support-contact-note">
            Nền tảng không có biểu mẫu liên hệ; vui lòng dùng email hoặc điện thoại ở trên.
          </p>
        </section>

        <section className="support-card support-faq" aria-labelledby="support-faq-title">
          <div className="support-card-head">
            <span className="support-card-icon support-card-icon-red">
              <IconHelp />
            </span>
            <div className="support-card-copy">
              <h2 className="support-card-title" id="support-faq-title">
                Câu hỏi thường gặp
              </h2>
              <p className="support-card-sub">
                Chín tình huống thường gặp khi dùng nền tảng.
              </p>
            </div>
          </div>

          <ul className="support-faq-list">
            {FAQ_ITEMS.map((item) => {
              const triggerId = `support-faq-trigger-${item.id}`;
              const panelId = `support-faq-panel-${item.id}`;
              const open = openFaqId === item.id;
              return (
                <li className="support-faq-item" key={item.id} data-open={open ? "true" : "false"}>
                  <h3 className="support-faq-question">
                    <button
                      type="button"
                      className="support-faq-trigger"
                      id={triggerId}
                      aria-expanded={open}
                      aria-controls={panelId}
                      onClick={() => setOpenFaqId((current) => (current === item.id ? null : item.id))}
                    >
                      <span>{item.question}</span>
                      <svg
                        className="support-faq-chevron"
                        viewBox="0 0 24 24"
                        width={18}
                        height={18}
                        fill="none"
                        stroke="currentColor"
                        strokeWidth={2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                        focusable="false"
                      >
                        <path d="m7 10 5 5 5-5" />
                      </svg>
                    </button>
                  </h3>
                  {/* Panel luôn được mount, chỉ đóng bằng thuộc tính `hidden` để `aria-controls`
                      không trỏ vào phần tử không tồn tại. */}
                  <div
                    className="support-faq-panel"
                    id={panelId}
                    role="region"
                    aria-labelledby={triggerId}
                    hidden={!open}
                  >
                    <p className="support-faq-answer">{item.answer}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </div>
  );
}
