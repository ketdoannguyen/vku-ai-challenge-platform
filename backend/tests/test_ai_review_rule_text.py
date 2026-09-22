"""Canonicalizer văn bản luật: bỏ trình bày, giữ ngữ nghĩa, tất định và idempotent."""

import unicodedata

from app.ai_review.rule_text import canonicalize_heading_text, canonicalize_rule_text


def test_collapses_whitespace_tabs_and_newlines():
    assert canonicalize_rule_text("  Không   được\n\tdùng  ") == "Không được dùng"


def test_crlf_and_cr_become_the_same_single_spaced_text():
    assert canonicalize_rule_text("Không được\r\ndùng\r\n") == "Không được dùng"
    assert canonicalize_rule_text("Không được\rdùng\r") == "Không được dùng"


def test_blank_input_stays_empty():
    assert canonicalize_rule_text("   \n\t\n ") == ""


def test_strips_heading_blockquote_and_list_markers():
    source = "### A-R1 — Cấm\n> Không được dùng\n- Không được shuffle\n1. Không được hard-code"
    assert canonicalize_rule_text(source) == (
        "A-R1 — Cấm Không được dùng Không được shuffle Không được hard-code"
    )


def test_nested_markers_are_all_stripped():
    assert canonicalize_rule_text("> > **Không** được dùng") == "Không được dùng"
    assert canonicalize_rule_text("  - - Không được dùng") == "Không được dùng"


def test_unwraps_bold_italic_code_links_and_images():
    source = "**Không** *được* `dùng` [liên kết](http://x) ![ảnh](y.png) [xem][ref]"
    assert canonicalize_rule_text(source) == "Không được dùng liên kết ảnh xem"


def test_identifiers_and_numbers_keep_their_underscores_and_digits():
    for identifier in (
        "device_id",
        "future_label",
        "n_estimators",
        "load_state_dict",
        "next_label",
    ):
        assert canonicalize_rule_text(identifier) == identifier
    assert canonicalize_rule_text("2*3*4") == "2*3*4"
    assert canonicalize_rule_text("tối đa 1 MiB = 1,048,576 byte") == (
        "tối đa 1 MiB = 1,048,576 byte"
    )
    assert canonicalize_rule_text("2024") == "2024"
    assert canonicalize_rule_text(">95") == ">95"
    assert canonicalize_rule_text("1.5") == "1.5"


def test_nfc_and_nfd_vietnamese_canonicalize_identically():
    composed = "Không được dùng cột device_id"
    decomposed = unicodedata.normalize("NFD", composed)
    assert composed != decomposed
    assert canonicalize_rule_text(decomposed) == canonicalize_rule_text(composed)


def test_numbers_negation_and_case_stay_significant():
    assert canonicalize_rule_text("tối đa 1 MiB") != canonicalize_rule_text("tối đa 2 MiB")
    assert canonicalize_rule_text("Không được dùng") != canonicalize_rule_text("Được dùng")
    assert canonicalize_rule_text("không được dùng") != canonicalize_rule_text("Không được dùng")


def test_ellipsis_and_paraphrase_are_not_treated_as_equal():
    assert canonicalize_rule_text("Không được dùng...") != canonicalize_rule_text(
        "Không được dùng…"
    )
    assert canonicalize_rule_text("Không được dùng") != canonicalize_rule_text("Không được sử dụng")


def test_source_block_and_model_quote_canonicalize_the_same():
    source = "- **Không được** dùng cột `device_id`\nlàm đặc trưng huấn luyện."
    quote = "Không được dùng cột device_id làm đặc trưng huấn luyện."
    assert canonicalize_rule_text(source) == canonicalize_rule_text(quote)


def test_emphasis_spanning_a_line_wrap_is_unwrapped():
    wrapped = "- **Nếu dùng `RandomForestClassifier`,\n  `n_estimators` không được vượt quá 30.**"
    flat = "- Nếu dùng RandomForestClassifier, n_estimators không được vượt quá 30."
    assert canonicalize_rule_text(wrapped) == canonicalize_rule_text(flat)


def test_inline_code_keeps_emphasis_like_content_literal():
    # Code span là literal: `*`/`_` bên trong được escape thành cặp bất động thay vì bị bóc.
    assert canonicalize_rule_text("`__init__`") == r"\_\_init\_\_"
    assert canonicalize_rule_text("`*args`") == r"\*args"
    assert canonicalize_rule_text("`**kwargs`") == r"\*\*kwargs"
    assert canonicalize_rule_text(
        "Khởi tạo `__init__` với `*args` và `**kwargs`."
    ) == r"Khởi tạo \_\_init\_\_ với \*args và \*\*kwargs."


def test_bare_programming_tokens_converge_with_backticked_source():
    # Model thường bỏ backtick khi trích nguyên văn; token trần phải về cùng canonical với nguồn.
    for token in ("__init__", "*args", "**kwargs"):
        assert canonicalize_rule_text(f"`{token}`") == canonicalize_rule_text(token)
    source = "Khởi tạo `__init__` với `*args` và `**kwargs`."
    quote = "Khởi tạo __init__ với *args và **kwargs."
    assert canonicalize_rule_text(source) == canonicalize_rule_text(quote)


def test_identifiers_with_interior_underscore_are_not_escaped():
    # `_` nằm trọn giữa hai ký tự chữ không thể mở/đóng emphasis nên không cần escape.
    for identifier in ("device_id", "n_estimators", "load_state_dict", "list[int]", "train.csv"):
        assert canonicalize_rule_text(f"`{identifier}`") == identifier


def test_code_with_links_markers_and_backslashes_stays_literal_and_stable():
    assert canonicalize_rule_text("`[x](y)`") == r"\[x\](y)"
    assert canonicalize_rule_text("`[x][ref]`") == r"\[x\]\[ref\]"
    assert canonicalize_rule_text("`- x`") == r"\- x"
    assert canonicalize_rule_text("`1. x`") == r"1\. x"
    assert canonicalize_rule_text("`# x`") == r"\# x"
    assert canonicalize_rule_text(r"`a\b`") == r"a\\b"


def test_emphasis_like_text_outside_code_is_still_presentation():
    # Cùng ký tự ngoài backtick vẫn là emphasis Markdown, không phải nội dung literal.
    assert canonicalize_rule_text("*được* **Không**") == "được Không"
    assert canonicalize_rule_text("**C-R1 — Không dùng định danh:** x") == (
        "C-R1 — Không dùng định danh: x"
    )
    # `*args*` là emphasis thật, không phải token trần; `__AutoML__` không phải dunder.
    assert canonicalize_rule_text("*args*") == "args"
    assert canonicalize_rule_text("__AutoML__") == "AutoML"
    # Escape Markdown có sẵn không bị bóc như trình bày.
    assert canonicalize_rule_text(r"\*không phải emphasis\*") == r"\*không phải emphasis\*"


def test_marker_exposed_by_whitespace_collapse_converges_to_fixed_point():
    # Gộp khoảng trắng có thể làm lộ marker đầu dòng; vòng lặp phải chạy tới điểm bất động.
    assert canonicalize_rule_text("*\na") == "a"
    assert canonicalize_rule_text("-\na") == "a"
    assert canonicalize_rule_text("- *\nx") == "x"
    assert canonicalize_rule_text("**- Không được dùng**") == "Không được dùng"


def test_fixed_point_loop_does_not_invent_markers_inside_ordinary_content():
    # Marker giữa câu hoặc số thập phân không phải marker đầu dòng, dù có gộp khoảng trắng.
    assert canonicalize_rule_text("dùng 2*3*4 ở giữa") == "dùng 2*3*4 ở giữa"
    assert canonicalize_rule_text("phiên bản 1.5 là bắt buộc") == "phiên bản 1.5 là bắt buộc"
    assert canonicalize_rule_text("a\n* b") == "a b"


def test_heading_canonical_keeps_ordinal_while_rule_text_strips_list_marker():
    assert canonicalize_heading_text("1. Phạm vi") == "1. Phạm vi"
    assert canonicalize_heading_text("**1. Phạm vi**") == "1. Phạm vi"
    # Rule block vẫn bóc marker danh sách như cũ, không bị nới lỏng.
    assert canonicalize_rule_text("1. Phạm vi") == "Phạm vi"


def test_canonicalization_is_idempotent_on_every_sample():
    samples = [
        "### A-R1 — Cấm\n> **Không** được dùng `device_id`\n- [xem](u) và ![ảnh](y)",
        "[[xem](a)](b) và `giữ nguyên`",
        "  Không   được\n\tdùng  ",
        "- **C-R1 — Không dùng định danh:** Không được dùng cột `device_id`.",
        "*\na",
        "**- Không được dùng**",
        # Đoạn trích B/E thật: heading có số đánh mục, code span và bold lồng nhau.
        "### B-R3 — Giới hạn kích thước mô hình: tối đa 2 MiB\n"
        "- Artifact cuối cùng phải **không vượt quá 2 MiB = 2,097,152 byte**.",
        "- **E-R2 — Không AutoML:** Cấm `PyCaret`, `AutoGluon`, `H2O AutoML`, `auto-sklearn`.",
        # Code span chứa ký tự trọng yếu: mỗi mẫu từng làm canonical đổi ở lần chạy thứ hai.
        "`__init__` và `*args`, `**kwargs`",
        "`*giữ*` và `_giữ_`",
        "`[x](y)` và `[x][ref]`",
        "`- x`, `1. x`, `# x`",
        "`a_`, `_a`, `device_id`, `list[int]`",
        r"`a\b` và \*escape có sẵn\*",
        "Khởi tạo `__init__` với `*args` và `**kwargs`.",
        "Khởi tạo __init__ với *args và **kwargs.",
    ]
    for sample in samples:
        once = canonicalize_rule_text(sample)
        assert canonicalize_rule_text(once) == once
    assert canonicalize_heading_text("1. Phạm vi") == canonicalize_heading_text(
        canonicalize_heading_text("1. Phạm vi")
    )
