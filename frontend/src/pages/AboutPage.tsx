/** Trang tĩnh công khai: giới thiệu nền tảng nhiều cuộc thi AI và đơn vị chủ trì VKU. */

import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import {
  KHCN_HTQT_NAME,
  PLATFORM_SUPPORT_NAME,
  VKU_ADDRESS,
  VKU_NAME,
  VKU_SOURCES,
  type VkuSource,
} from "../lib/vkuInfo";

const SOURCES: VkuSource[] = [
  VKU_SOURCES.about,
  VKU_SOURCES.contact,
  VKU_SOURCES.department,
  VKU_SOURCES.udn,
];

/** Icon SVG inline dùng chung trong trang; luôn là trang trí nên ẩn khỏi cây trợ năng. */
function Icon({
  children,
  size = 18,
  strokeWidth = 1.75,
  className,
}: {
  children: ReactNode;
  size?: number;
  strokeWidth?: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
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

function IconLandmark({ className }: { className?: string }) {
  return (
    <Icon className={className} strokeWidth={1.6}>
      <path d="M3 21h18" />
      <path d="M5 21V9.5l7-5 7 5V21" />
      <path d="M9.5 21v-6h5v6" />
    </Icon>
  );
}

function IconUniversity() {
  return (
    <Icon>
      <path d="M12 3.5 3.5 8 12 12.5 20.5 8 12 3.5Z" />
      <path d="M6.5 10v6.2c0 1.4 2.5 2.5 5.5 2.5s5.5-1.1 5.5-2.5V10" />
    </Icon>
  );
}

function IconLayers() {
  return (
    <Icon>
      <path d="m12 3.5 8.5 4.5-8.5 4.5L3.5 8 12 3.5Z" />
      <path d="m3.5 13 8.5 4.5L20.5 13" />
    </Icon>
  );
}

function IconGrid() {
  return (
    <Icon>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </Icon>
  );
}

function IconEye() {
  return (
    <Icon>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  );
}

function IconUser() {
  return (
    <Icon>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </Icon>
  );
}

function IconFileText() {
  return (
    <Icon>
      <path d="M14 3.5H7a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5L14 3.5Z" />
      <path d="M14 3.5v5h5" />
      <path d="M9 13h6m-6 4h4" />
    </Icon>
  );
}

function IconUsers() {
  return (
    <Icon>
      <circle cx="9.5" cy="8.5" r="3.2" />
      <path d="M3.5 19.5a6 6 0 0 1 12 0" />
      <path d="M16.5 5.8a3.2 3.2 0 0 1 0 6.2" />
      <path d="M17.5 14.8a5.6 5.6 0 0 1 3 3.7" />
    </Icon>
  );
}

function IconIdCard() {
  return (
    <Icon size={16}>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <circle cx="9" cy="11" r="2" />
      <path d="M6 16c.7-1.3 1.7-2 3-2s2.3.7 3 2" />
      <path d="M15 10h4m-4 3.5h4" />
    </Icon>
  );
}

function IconNetwork() {
  return (
    <Icon size={16}>
      <circle cx="12" cy="6.5" r="2.8" />
      <circle cx="5.5" cy="17.5" r="2.8" />
      <circle cx="18.5" cy="17.5" r="2.8" />
      <path d="M12 9.3v3.4m0 0-4.2 2.6m4.2-2.6 4.2 2.6" />
    </Icon>
  );
}

function IconCalendar() {
  return (
    <Icon size={16}>
      <rect x="3.5" y="5" width="17" height="16" rx="2.5" />
      <path d="M3.5 10h17M8 3v4m8-4v4" />
    </Icon>
  );
}

function IconTarget() {
  return (
    <Icon size={16}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="4.5" />
      <circle cx="12" cy="12" r="0.8" />
    </Icon>
  );
}

function IconMapPin() {
  return (
    <Icon size={16}>
      <path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11Z" />
      <circle cx="12" cy="10" r="2.8" />
    </Icon>
  );
}

function IconBuilding() {
  return (
    <Icon>
      <rect x="4.5" y="3.5" width="15" height="17" rx="2" />
      <path d="M9.5 20.5v-5h5v5" />
      <path d="M8.5 8h2m3 0h2m-7 3.5h2m3 0h2" />
    </Icon>
  );
}

function IconFlask() {
  return (
    <Icon>
      <path d="M9 3.5h6" />
      <path d="M10.5 3.5v6l-4.6 7.9a2 2 0 0 0 1.7 3h8.8a2 2 0 0 0 1.7-3L13.5 9.5v-6" />
      <path d="M8.2 14.5h7.6" />
    </Icon>
  );
}

function IconHeadset() {
  return (
    <Icon>
      <path d="M4.5 13a7.5 7.5 0 0 1 15 0" />
      <path d="M4.5 13h2a1 1 0 0 1 1 1v3.5a1 1 0 0 1-1 1h-1a1 1 0 0 1-1-1V13Z" />
      <path d="M19.5 13h-2a1 1 0 0 0-1 1v3.5a1 1 0 0 0 1 1h1a1 1 0 0 0 1-1V13Z" />
    </Icon>
  );
}

function IconLink() {
  return (
    <Icon>
      <path d="M10.2 13.8a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7L11.4 6.9" />
      <path d="M13.8 10.2a4 4 0 0 0-5.7 0l-2.8 2.8a4 4 0 0 0 5.7 5.7l1.6-1.6" />
    </Icon>
  );
}

function IconArrowRight() {
  return (
    <Icon>
      <path d="M4.5 12h15" />
      <path d="m13.5 6 6 6-6 6" />
    </Icon>
  );
}

/** Nhịp màu trang trí cho icon feature; xoay vòng theo thứ tự khai báo, không mang nghĩa nghiệp vụ. */
type Tone = "blue" | "red" | "yellow";

type PlatformFeature = { title: string; body: string; icon: ReactNode; tone: Tone };
type HostFact = { label: string; value: string; icon: ReactNode };
type SupportUnit = { name: string; body: string; icon: ReactNode };

const PLATFORM_FEATURES: PlatformFeature[] = [
  {
    title: "Một website, nhiều cuộc thi",
    body: "Mỗi cuộc thi có trang riêng gồm thể lệ, đề bài và tài liệu, tài nguyên tải về, hạn mức nộp bài và bảng xếp hạng.",
    icon: <IconGrid />,
    tone: "blue",
  },
  {
    title: "Đọc công khai",
    body: "Danh sách và trang chi tiết cuộc thi đọc được không cần đăng nhập; các thao tác gắn với tài khoản như tham gia, nộp bài và xem bảng xếp hạng thì cần đăng nhập.",
    icon: <IconEye />,
    tone: "blue",
  },
  {
    title: "Tài khoản",
    body: "Do Ban Tổ chức cấp; nền tảng không có đăng ký tự do.",
    icon: <IconUser />,
    tone: "red",
  },
  {
    title: "Thể lệ và bài nộp",
    body: "Chế độ tham gia, cột dữ liệu, định dạng tệp và hạn mức nộp do Ban Tổ chức cấu hình cho từng cuộc thi.",
    icon: <IconFileText />,
    tone: "yellow",
  },
];

const HOST_FACTS: HostFact[] = [
  { label: "Tên đầy đủ", value: VKU_NAME, icon: <IconIdCard /> },
  {
    label: "Đại học Đà Nẵng",
    value: "VKU là trường đại học thành viên của Đại học Đà Nẵng.",
    icon: <IconNetwork />,
  },
  {
    label: "Thành lập",
    value: "Theo Quyết định số 15/QĐ-TTg ngày 03/01/2020 của Thủ tướng Chính phủ.",
    icon: <IconCalendar />,
  },
  {
    label: "Sứ mệnh",
    value:
      "Đào tạo nguồn nhân lực chất lượng cao, nghiên cứu khoa học, chuyển giao tri thức và công nghệ về công nghệ thông tin, truyền thông, kinh tế số và các lĩnh vực liên quan.",
    icon: <IconTarget />,
  },
  { label: "Địa chỉ", value: VKU_ADDRESS, icon: <IconMapPin /> },
];

const SUPPORT_UNITS: SupportUnit[] = [
  {
    name: VKU_NAME,
    body: "Đơn vị chủ trì nền tảng và tổ chức các cuộc thi.",
    icon: <IconBuilding />,
  },
  {
    name: KHCN_HTQT_NAME,
    body: "Đầu mối về hoạt động khoa học công nghệ và hợp tác quốc tế của Trường.",
    icon: <IconFlask />,
  },
  {
    name: PLATFORM_SUPPORT_NAME,
    body: "Hỗ trợ kỹ thuật nền tảng: tài khoản, đăng nhập và các sự cố khi dùng hệ thống.",
    icon: <IconHeadset />,
  },
];

export function AboutPage() {
  useDocumentTitle("Giới thiệu");

  return (
    <div className="about-page">
      <header className="page-hero">
        <div className="page-hero-row">
          <span className="page-hero-icon" aria-hidden="true">
            <IconLandmark className="page-hero-glyph" />
          </span>
          <div className="page-hero-copy">
            <h1 className="page-hero-title">Giới thiệu</h1>
            <p className="page-hero-subtitle">Nền tảng tổ chức các cuộc thi AI của {VKU_NAME}.</p>
            <span className="vku-accent" aria-hidden="true">
              <span className="blue" />
              <span className="red" />
              <span className="yellow" />
            </span>
          </div>
        </div>
      </header>

      {/* Hai wrapper `about-col` chỉ tồn tại để mỗi cột xếp dọc độc lập ở desktop;
          dưới 1200px chúng `display: contents` nên năm card vẫn theo đúng thứ tự
          DOM: Nền tảng → VKU → Hỗ trợ → Bắt đầu → Nguồn. */}
      <div className="about-grid">
        <div className="about-col about-col-left">
          <section className="about-card about-platform" aria-labelledby="about-platform-title">
            <div className="about-card-head">
              <span className="about-card-icon about-card-icon-blue">
                <IconLayers />
              </span>
              <div className="about-card-copy">
                <h2 className="about-card-title" id="about-platform-title">
                  Về nền tảng AI Challenge
                </h2>
              </div>
            </div>

            <ul className="about-feature-list">
              {PLATFORM_FEATURES.map((feature) => (
                <li className="about-feature" key={feature.title}>
                  <span
                    className={`about-feature-icon about-feature-icon-${feature.tone}`}
                    aria-hidden="true"
                  >
                    {feature.icon}
                  </span>
                  <div className="about-feature-body">
                    <h3 className="about-feature-title">{feature.title}</h3>
                    <p className="about-feature-text">{feature.body}</p>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="about-card about-vku" aria-labelledby="about-vku-title">
            <div className="about-card-head">
              <span className="about-card-icon about-card-icon-red">
                <IconUniversity />
              </span>
              <div className="about-card-copy">
                <h2 className="about-card-title" id="about-vku-title">
                  VKU — đơn vị chủ trì
                </h2>
              </div>
            </div>

            <ul className="about-fact-list" aria-label="Thông tin VKU">
              {HOST_FACTS.map((fact) => (
                <li className="about-fact" key={fact.label}>
                  <span className="about-fact-icon" aria-hidden="true">
                    {fact.icon}
                  </span>
                  <div className="about-fact-body">
                    <h3 className="about-fact-title">{fact.label}</h3>
                    <p className="about-fact-text">{fact.value}</p>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <div className="about-col about-col-right">
          <section className="about-card about-support" aria-labelledby="about-support-title">
            <div className="about-card-head">
              <span className="about-card-icon about-card-icon-yellow">
                <IconUsers />
              </span>
              <div className="about-card-copy">
                <h2 className="about-card-title" id="about-support-title">
                  Đơn vị và đầu mối hỗ trợ
                </h2>
              </div>
            </div>

            <ul className="about-unit-list">
              {SUPPORT_UNITS.map((unit) => (
                <li className="about-unit" key={unit.name}>
                  <span className="about-unit-icon" aria-hidden="true">
                    {unit.icon}
                  </span>
                  <div className="about-unit-body">
                    <h3 className="about-unit-title">{unit.name}</h3>
                    <p className="about-unit-text">{unit.body}</p>
                  </div>
                </li>
              ))}
            </ul>

            <p className="about-note">
              Thông tin liên hệ đầy đủ ở trang <Link to="/ho-tro">Hỗ trợ &amp; Liên hệ</Link>.
            </p>
          </section>

          <section className="about-card about-cta" aria-labelledby="about-cta-title">
            <div className="about-card-head">
              <span className="about-card-icon about-card-icon-blue">
                <IconArrowRight />
              </span>
              <div className="about-card-copy">
                <h2 className="about-card-title" id="about-cta-title">
                  Bắt đầu
                </h2>
              </div>
            </div>

            <div className="about-cta-body">
              <Link className="btn about-cta-link" to="/">
                Xem danh sách cuộc thi
              </Link>
              <div className="about-cta-accent" aria-hidden="true">
                <span />
                <span />
              </div>
            </div>
          </section>
        </div>

        <section className="about-card about-sources" aria-labelledby="about-sources-title">
          <div className="about-card-head">
            <span className="about-card-icon about-card-icon-neutral">
              <IconLink />
            </span>
            <div className="about-card-copy">
              <h2 className="about-card-title" id="about-sources-title">
                Nguồn thông tin
              </h2>
            </div>
          </div>

          <ul className="resource-list">
            {SOURCES.map((source) => (
              <li key={source.url}>
                <a
                  className="resource-link"
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                >
                  <span className="resource-label">{source.label}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
