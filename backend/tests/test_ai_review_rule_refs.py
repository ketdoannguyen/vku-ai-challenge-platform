"""Phân đoạn thể lệ, `rule_ref` ổn định và policy render: tất định, fail closed, không fuzzy."""

import pytest

from app.ai_review.rule_refs import (
    DUPLICATE_PAGE_SLUG,
    KIND_BLOCKQUOTE,
    KIND_LIST_ITEM,
    KIND_PARAGRAPH,
    KIND_TABLE_ROW,
    RuleIndexError,
    build_rule_index,
    render_annotated_policy,
)

PAGE_C = """# Quy định — Sensor Binary Classification

Mục tiêu: dự đoán `label` (0/1) từ dữ liệu cảm biến.

- **C-R1 — Không dùng định danh:** Không được dùng cột `device_id` làm đặc trưng huấn luyện hoặc suy luận.
- **C-R2 — Giới hạn Random Forest:** Nếu dùng `RandomForestClassifier`, `n_estimators` không được vượt quá **30**.

File nộp: CSV gồm đúng hai cột `id,label`.
"""


PAGE_B = """# QUY ĐỊNH CUỘC THI B — TEXT CLASSIFICATION CLASSIC ML

## 1. Phạm vi

Thí sinh phân loại văn bản nhị phân bằng machine learning cổ điển.

## 2. Quy định bắt buộc

### B-R1 — Cấm pretrained model

- Không được dùng mô hình ngôn ngữ pretrained hoặc checkpoint đã học từ dữ liệu ngoài.
- TF-IDF học trực tiếp từ `train.csv` là hợp lệ.

### B-R3 — Giới hạn kích thước mô hình: tối đa 2 MiB

- Artifact cuối cùng phải **không vượt quá 2 MiB = 2,097,152 byte**.
"""

PAGE_E = """# Quy định — Small Ensemble Binary Classification

Mục tiêu: dự đoán `label` (0/1).

- **E-R1 — Ensemble tối đa 2 model:** Không được kết hợp quá **2** model trong một dự đoán.
- **E-R2 — Không AutoML:** Cấm `PyCaret`, `AutoGluon`, `H2O AutoML`, `auto-sklearn`.
"""


def _page(slug, markdown, *, title=None, order=10):
    return {"slug": slug, "title": title or slug, "order": order, "markdown": markdown}


def _refs(pages):
    return [block.ref for block in build_rule_index(pages).blocks]


def test_paragraphs_and_list_items_become_blocks_under_the_atx_heading_path():
    index = build_rule_index([_page("rules-c", PAGE_C)])
    assert [block.kind for block in index.blocks] == [
        KIND_PARAGRAPH,
        KIND_LIST_ITEM,
        KIND_LIST_ITEM,
        KIND_PARAGRAPH,
    ]
    assert all(
        block.heading_path == ("Quy định — Sensor Binary Classification",)
        for block in index.blocks
    )
    assert index.blocks[0].canonical_text == "Mục tiêu: dự đoán label (0/1) từ dữ liệu cảm biến."
    assert index.blocks[1].canonical_text == (
        "C-R1 — Không dùng định danh: Không được dùng cột device_id "
        "làm đặc trưng huấn luyện hoặc suy luận."
    )


def test_raw_text_keeps_the_marker_and_block_lines_point_at_the_source():
    index = build_rule_index(
        [_page("rules", "# Tiêu đề\n\n- Không được dùng device_id.\nlàm đặc trưng.")]
    )
    block = index.blocks[0]
    assert (block.start_line, block.end_line) == (3, 4)
    assert block.raw_text == "- Không được dùng device_id.\nlàm đặc trưng."
    assert block.heading_path == ("Tiêu đề",)


def test_setext_heading_updates_the_heading_path_and_is_not_a_block():
    index = build_rule_index([_page("rules", "Quy định chung\n===\n\n- Không được dùng device_id.")])
    assert len(index.blocks) == 1
    assert index.blocks[0].heading_path == ("Quy định chung",)
    assert index.blocks[0].kind == KIND_LIST_ITEM


def test_blockquote_paragraph_is_citable():
    index = build_rule_index([_page("rules", "> Không được dùng device_id làm đặc trưng.")])
    assert index.blocks[0].kind == KIND_BLOCKQUOTE
    assert index.blocks[0].canonical_text == "Không được dùng device_id làm đặc trưng."


def test_table_data_rows_are_citable_but_header_and_separator_are_not():
    page = _page(
        "rules",
        "| Mã | Quy định |\n| --- | --- |\n"
        "| A-R1 | Không được dùng pretrained model. |\n"
        "| A-R2 | Mô hình tối đa 1 MiB. |",
    )
    index = build_rule_index([page])
    assert [block.kind for block in index.blocks] == [KIND_TABLE_ROW, KIND_TABLE_ROW]
    assert "A-R1" in index.blocks[0].raw_text
    assert "Mã" not in "".join(block.raw_text for block in index.blocks)


def test_fenced_code_is_kept_in_the_policy_but_not_citable():
    page = _page(
        "rules",
        "Notebook phải xuất CSV:\n\n```text\nid,label\n```\n\n- Không được dùng device_id.",
    )
    index = build_rule_index([page])
    assert [block.kind for block in index.blocks] == [KIND_PARAGRAPH, KIND_LIST_ITEM]
    assert all("id,label" not in block.raw_text for block in index.blocks)

    rendered = render_annotated_policy([page], index)
    assert "id,label" in rendered
    assert rendered.count("[RULE_REF ") == 2


def test_a_different_fence_character_does_not_close_the_block():
    page = _page("rules", "Ví dụ:\n\n```text\n~~~\n```\n\n- Không được dùng device_id.")
    index = build_rule_index([page])
    assert [block.kind for block in index.blocks] == [KIND_PARAGRAPH, KIND_LIST_ITEM]
    assert all("~~~" not in block.raw_text for block in index.blocks)


def test_unclosed_fence_makes_the_rest_of_the_page_uncitable():
    page = _page(
        "rules",
        "Mở ví dụ:\n\n```python\nprint('x')\n- Không được dùng device_id.",
    )
    index = build_rule_index([page])
    assert [block.kind for block in index.blocks] == [KIND_PARAGRAPH]
    assert index.blocks[0].raw_text == "Mở ví dụ:"


def test_ref_is_stable_when_only_formatting_and_reflow_change():
    plain = _refs([_page("rules", "- Không được dùng cột device_id làm đặc trưng.")])[0]
    reflowed = _refs(
        [_page("rules", "- **Không được** dùng cột `device_id`\nlàm đặc trưng.")]
    )[0]
    assert plain == reflowed
    assert "~" not in plain


def test_ref_is_stable_when_bold_spans_a_line_wrap():
    flat = _refs([_page("rules", "- Nếu dùng `n_estimators` không được vượt quá 30.")])[0]
    wrapped = _refs(
        [_page("rules", "- **Nếu dùng `n_estimators`\n  không được vượt quá 30.**")]
    )[0]
    assert flat == wrapped


def test_ref_changes_when_number_negation_or_heading_context_changes():
    base = _refs([_page("rules", "- Không được vượt quá 30.")])[0]
    assert _refs([_page("rules", "- Không được vượt quá 31.")])[0] != base
    assert _refs([_page("rules", "- Được vượt quá 30.")])[0] != base
    assert _refs([_page("rules", "## Khác\n\n- Không được vượt quá 30.")])[0] != base


def test_same_text_in_two_pages_gets_different_refs():
    first = _refs([_page("rules-a", "- Không được dùng device_id.")])[0]
    second = _refs([_page("rules-b", "- Không được dùng device_id.")])[0]
    assert first != second
    assert first.startswith("rules-a#") and second.startswith("rules-b#")


def test_identical_blocks_in_the_same_namespace_get_occurrence_suffixes():
    index = build_rule_index(
        [_page("rules", "- Không được dùng device_id.\n- Không được dùng device_id.")]
    )
    refs = [block.ref for block in index.blocks]
    assert len(refs) == 2
    assert refs[0].endswith("~1") and refs[1].endswith("~2")
    assert refs[0][:-2] == refs[1][:-2]
    # Hai block canonical giống hệt nhau: tra quote không được phép chọn đại một cái.
    assert len(index.candidates_for_quote("Không được dùng device_id.")) == 2


def test_duplicate_page_slugs_fail_closed():
    with pytest.raises(RuleIndexError) as exc:
        build_rule_index([_page("rules", "- A."), _page("rules", "- B.")])
    assert exc.value.code == DUPLICATE_PAGE_SLUG


def test_ref_lookup_returns_the_block_and_unknown_ref_is_none():
    index = build_rule_index([_page("rules", "- Không được dùng device_id.")])
    ref = index.blocks[0].ref
    assert index.get(ref).ref == ref
    assert index.get("rules#000000000000000000000000") is None


def test_canonical_quote_resolves_only_when_it_is_unique_and_exact():
    index = build_rule_index(
        [_page("rules", "- Không được dùng device_id.\n- Không được dùng future_label.")]
    )
    [candidate] = index.candidates_for_quote("Không được dùng `device_id`.")
    assert candidate.kind == KIND_LIST_ITEM
    # Không substring, không paraphrase: chỉ exact canonical mới trúng.
    assert index.candidates_for_quote("Không được dùng device_id") == ()
    assert index.candidates_for_quote("Không được dùng ground_truth.") == ()


def test_render_keeps_every_source_line_once_and_inserts_each_ref_once():
    page = _page(
        "rules",
        "# Tiêu đề\n\n- Không được dùng device_id.\n\n```text\nid,label\n```\n",
    )
    index = build_rule_index([page])
    rendered = render_annotated_policy([page], index)

    body = [line for line in rendered.split("\n") if not line.startswith("[RULE_REF ")]
    assert "\n".join(body) == (
        "=== PAGE 1 | slug=rules | order=10 | rules ===\n"
        "# Tiêu đề\n\n- Không được dùng device_id.\n\n```text\nid,label\n```\n"
    )
    assert rendered.count("[RULE_REF ") == 1
    assert f"[RULE_REF {index.blocks[0].ref}]" in rendered


def test_render_covers_every_page_in_order_with_unique_refs():
    pages = [
        _page("rules-a", "# A\n\n- Không được dùng device_id.", title="A", order=1),
        _page("rules-b", "# B\n\n- Không được shuffle dữ liệu.", title="B", order=2),
    ]
    index = build_rule_index(pages)
    rendered = render_annotated_policy(pages, index)

    assert rendered.count("[RULE_REF ") == 2
    assert rendered.index("[RULE_REF rules-a#") < rendered.index("[RULE_REF rules-b#")
    for block in index.blocks:
        assert rendered.count(f"[RULE_REF {block.ref}]") == 1
    assert "=== PAGE 1 | slug=rules-a | order=1 | A ===" in rendered
    assert "=== PAGE 2 | slug=rules-b | order=2 | B ===" in rendered


def test_representative_policy_pages_produce_stable_unique_refs():
    pages = [
        _page(
            "rules-a",
            "# QUY ĐỊNH A\n\n### A-R1 — Không dùng pretrained\n"
            "- Không được tải hoặc nạp trọng số đã huấn luyện trước.\n"
            "- Không được dùng `load_state_dict(...)` từ checkpoint pretrained.",
            title="Quy định A",
            order=1,
        ),
        _page(
            "rules-c",
            "# Quy định — Sensor\n\n"
            "- **C-R1 — Không dùng định danh:** Không được dùng cột `device_id` "
            "làm đặc trưng.",
            title="Quy định C",
            order=2,
        ),
        _page(
            "rules-d",
            "# Quy định — Time\n\n"
            "- **D-R1 — Giữ thứ tự thời gian:** Khi chia train/validation "
            "không được shuffle dữ liệu.",
            title="Quy định D",
            order=3,
        ),
    ]
    index = build_rule_index(pages)
    refs = [block.ref for block in index.blocks]
    assert len(refs) == len(set(refs)) == 4
    assert all(block.ref.startswith(f"{block.page_slug}#") for block in index.blocks)

    [quote] = index.candidates_for_quote(
        "C-R1 — Không dùng định danh: Không được dùng cột device_id làm đặc trưng."
    )
    assert quote.page_slug == "rules-c"

    assert _refs(pages) == refs


def test_heading_ordinal_is_part_of_the_digest():
    # `1.`/`2.` phân biệt hai mục khác nghĩa; bóc như marker danh sách sẽ cho cùng một ref.
    first = _refs([_page("rules", "## 1. Phạm vi\n\n- Không được dùng device_id.")])
    second = _refs([_page("rules", "## 2. Phạm vi\n\n- Không được dùng device_id.")])
    assert first[0] != second[0]


def test_representative_b_rules_page_is_fully_citable_and_stable():
    page = _page(
        "rules-b",
        PAGE_B,
        title="Quy định B",
        order=1,
    )
    index = build_rule_index([page])
    assert [block.kind for block in index.blocks] == [
        KIND_PARAGRAPH,
        KIND_LIST_ITEM,
        KIND_LIST_ITEM,
        KIND_LIST_ITEM,
    ]
    top = "QUY ĐỊNH CUỘC THI B — TEXT CLASSIFICATION CLASSIC ML"
    assert index.blocks[0].heading_path == (top, "1. Phạm vi")
    assert index.blocks[1].heading_path == (
        top,
        "2. Quy định bắt buộc",
        "B-R1 — Cấm pretrained model",
    )
    assert index.blocks[2].canonical_text == (
        "TF-IDF học trực tiếp từ train.csv là hợp lệ."
    )
    assert index.blocks[3].canonical_text == (
        "Artifact cuối cùng phải không vượt quá 2 MiB = 2,097,152 byte."
    )

    refs = [block.ref for block in index.blocks]
    assert len(refs) == len(set(refs)) == 4
    assert _refs([page]) == refs
    assert len(index.candidates_for_quote("TF-IDF học trực tiếp từ `train.csv` là hợp lệ.")) == 1


def test_representative_e_rules_page_resolves_bold_and_code_rules():
    page = _page("rules-e", PAGE_E, title="Quy định E", order=2)
    index = build_rule_index([page])
    assert [block.kind for block in index.blocks] == [
        KIND_PARAGRAPH,
        KIND_LIST_ITEM,
        KIND_LIST_ITEM,
    ]
    assert index.blocks[1].canonical_text == (
        "E-R1 — Ensemble tối đa 2 model: Không được kết hợp quá 2 model trong một dự đoán."
    )
    assert index.blocks[2].canonical_text == (
        "E-R2 — Không AutoML: Cấm PyCaret, AutoGluon, H2O AutoML, auto-sklearn."
    )
    [resolved] = index.candidates_for_quote(
        "E-R2 — Không AutoML: Cấm `PyCaret`, `AutoGluon`, `H2O AutoML`, `auto-sklearn`."
    )
    assert resolved.kind == KIND_LIST_ITEM
