"""Kiểm tra phần thuần logic của cấu hình chấm v2: schema, CSV, output, dấu vân tay."""

import pytest

from app.scoring import contracts, csv_validation, revisions
from app.scoring.errors import ScoringValidationError
from app.scoring.models import (
    ColumnSpec,
    EvaluatorConfig,
    FileSchema,
    InputSchema,
    MetricDefinition,
    OutputContract,
    Verification,
    validate_evaluator_config,
    validate_input_schema,
    validate_output_contract,
)
from app.scoring.output_validation import check_contract, primary_score, validate_metrics


def _schema(**overrides) -> InputSchema:
    values = {
        "ground_truth": FileSchema(
            id_column="id",
            columns=[
                ColumnSpec(name="id", type="string"),
                ColumnSpec(name="label", type="string", allowed_values=["0", "1"]),
            ],
        ),
        "submission": FileSchema(
            id_column="id",
            columns=[
                ColumnSpec(name="id", type="string"),
                ColumnSpec(name="prediction", type="string", allowed_values=["0", "1"]),
            ],
        ),
    }
    values.update(overrides)
    return InputSchema(**values)


def _contract(**overrides) -> OutputContract:
    values = {
        "metrics": [
            MetricDefinition(key="accuracy", label="Accuracy", decimals=4),
            MetricDefinition(key="macro_f1", label="Macro F1", decimals=4),
        ],
        "primary_metric": "macro_f1",
        "higher_is_better": True,
    }
    values.update(overrides)
    return OutputContract(**values)


def _gt_csv(rows: str = "id,label\na,1\nb,0\nc,1\n") -> bytes:
    return rows.encode()


# --- schema -----------------------------------------------------------------------------------


def test_schema_hop_le_khi_cot_id_duoc_khai_bao():
    validate_input_schema(_schema())


def test_schema_tu_choi_cot_id_khong_nam_trong_danh_sach_cot():
    schema = _schema(
        submission=FileSchema(
            id_column="student_id",
            columns=[ColumnSpec(name="id", type="string"), ColumnSpec(name="prediction", type="string")],
        )
    )
    with pytest.raises(ScoringValidationError, match="cột ID"):
        validate_input_schema(schema)


def test_schema_tu_choi_cot_id_kieu_so_thuc_hoac_duoc_phep_trong():
    for column in (ColumnSpec(name="id", type="number"), ColumnSpec(name="id", type="string", nullable=True)):
        with pytest.raises(ScoringValidationError):
            validate_input_schema(
                _schema(
                    submission=FileSchema(
                        id_column="id",
                        columns=[column, ColumnSpec(name="prediction", type="string")],
                    )
                )
            )


def test_schema_tu_choi_hai_cot_id_khac_kieu_nhau():
    with pytest.raises(ScoringValidationError, match="cùng kiểu"):
        validate_input_schema(
            _schema(
                submission=FileSchema(
                    id_column="id",
                    columns=[
                        ColumnSpec(name="id", type="integer"),
                        ColumnSpec(name="prediction", type="string"),
                    ],
                )
            )
        )


def test_allowed_values_rong_hoac_trung_la_cau_hinh_sai():
    for values in ([], ["0", "0"]):
        with pytest.raises(ScoringValidationError, match="cho phép"):
            validate_input_schema(
                _schema(
                    submission=FileSchema(
                        id_column="id",
                        columns=[
                            ColumnSpec(name="id", type="string"),
                            ColumnSpec(name="prediction", type="string", allowed_values=values),
                        ],
                    )
                )
            )


def test_allowed_values_phai_dung_kieu_cua_cot():
    with pytest.raises(ScoringValidationError, match="kiểu"):
        validate_input_schema(
            _schema(
                submission=FileSchema(
                    id_column="id",
                    columns=[
                        ColumnSpec(name="id", type="string"),
                        ColumnSpec(name="prediction", type="string", allowed_values=[0, 1]),
                    ],
                )
            )
        )


def test_allowed_values_cua_cot_so_khong_duoc_la_chuoi():
    """Chuỗi trên cột number sẽ vỡ ở `float(candidate)` lúc chấm, nên phải bị chặn từ lúc khai báo."""
    for values in (["0", "A"], ["A"]):
        with pytest.raises(ScoringValidationError, match="number"):
            validate_input_schema(
                _schema(
                    submission=FileSchema(
                        id_column="id",
                        columns=[
                            ColumnSpec(name="id", type="string"),
                            ColumnSpec(name="score", type="number", allowed_values=values),
                        ],
                    )
                )
            )


# --- output contract --------------------------------------------------------------------------


def test_output_contract_hop_le():
    validate_output_contract(_contract())


def test_output_contract_tu_choi_khoa_metric_sai_dang():
    for key in ("1st_metric", "có dấu", "a" * 65, ""):
        with pytest.raises(ScoringValidationError, match="Khóa metric"):
            validate_output_contract(
                _contract(metrics=[MetricDefinition(key=key, label="X")], primary_metric=None)
            )


def test_output_contract_tu_choi_qua_nhieu_metric_hoac_so_thap_phan_sai():
    metrics = [MetricDefinition(key=f"m{index}", label="M") for index in range(21)]
    with pytest.raises(ScoringValidationError, match="Tối đa"):
        validate_output_contract(_contract(metrics=metrics, primary_metric=None))
    with pytest.raises(ScoringValidationError, match="thập phân"):
        validate_output_contract(
            _contract(metrics=[MetricDefinition(key="m", label="M", decimals=9)], primary_metric=None)
        )


def test_output_contract_tu_choi_metric_chinh_khong_nam_trong_danh_sach():
    with pytest.raises(ScoringValidationError, match="Metric chính"):
        validate_output_contract(_contract(primary_metric="khong_co"))


def test_output_contract_nhan_whitelist_metric_cho_thi_sinh():
    validate_output_contract(_contract(visible_metrics=["accuracy"]))
    # Mảng rỗng là "ẩn hết", vẫn là cấu hình hợp lệ; khác `None` là "không giới hạn".
    validate_output_contract(_contract(visible_metrics=[]))


def test_output_contract_tu_choi_whitelist_khoa_la_hoac_trung():
    with pytest.raises(ScoringValidationError, match="thí sinh thấy"):
        validate_output_contract(_contract(visible_metrics=["khong_co"]))
    with pytest.raises(ScoringValidationError, match="trùng"):
        validate_output_contract(_contract(visible_metrics=["accuracy", "accuracy"]))


def _v2_competition(**contract_overrides) -> dict:
    contract = _contract().model_dump()
    contract.update(contract_overrides)
    return {
        "scoring_config": {
            "version": 2,
            "input_schema": _schema().model_dump(),
            "evaluator": {"name": "Bộ chấm"},
            "output_contract": contract,
        }
    }


def test_participant_contract_giu_nguyen_khi_admin_chua_gioi_han():
    contract = contracts.participant_contract(_v2_competition())
    assert [metric.key for metric in contract.metrics] == ["accuracy", "macro_f1"]
    assert contract.primary_metric == "macro_f1"


def test_participant_contract_bo_metric_ngoai_whitelist_va_chi_so_chinh_bi_an():
    contract = contracts.participant_contract(_v2_competition(visible_metrics=["accuracy"]))
    assert [metric.key for metric in contract.metrics] == ["accuracy"]
    # macro_f1 là chỉ số chính nhưng bị ẩn: bảng xếp hạng vẫn xếp theo nó, chỉ không trả giá trị.
    assert contract.primary_metric is None


def test_apply_metric_visibility_loc_metrics_va_primary_score():
    contract = OutputContract(
        metrics=[MetricDefinition(key="accuracy", label="Accuracy")],
        primary_metric=None,
        visible_metrics=["accuracy"],
    )
    payload = {"metrics": {"accuracy": 1.0, "macro_f1": 0.5}, "primary_score": 0.5}
    contracts.apply_metric_visibility(payload, contract)
    assert payload == {"metrics": {"accuracy": 1.0}, "primary_score": None}


def test_apply_metric_visibility_khong_doi_payload_khi_chua_co_whitelist():
    contract = OutputContract(
        metrics=[MetricDefinition(key="accuracy", label="Accuracy")], primary_metric="accuracy"
    )
    payload = {"metrics": {"accuracy": 1.0, "extra": 2.0}, "primary_score": 1.0}
    contracts.apply_metric_visibility(payload, contract)
    assert payload == {"metrics": {"accuracy": 1.0, "extra": 2.0}, "primary_score": 1.0}


def test_evaluator_chi_nhan_diem_vao_evaluate():
    validate_evaluator_config(EvaluatorConfig(name="Bộ chấm"))
    with pytest.raises(ScoringValidationError, match="Điểm vào"):
        validate_evaluator_config(EvaluatorConfig(name="Bộ chấm", entrypoint="score"))


# --- CSV --------------------------------------------------------------------------------------


def test_ground_truth_doc_duoc_va_giu_thu_tu_id():
    truth = csv_validation.load_ground_truth(_gt_csv("id,label\nc,1\na,1\nb,0\n"), _schema().ground_truth)
    assert truth.ids == ("c", "a", "b")
    assert truth.row_count == 3


def test_ground_truth_bao_loi_co_ma_khi_thieu_cot():
    with pytest.raises(ScoringValidationError) as error:
        csv_validation.load_ground_truth(b"id\n1\n", _schema().ground_truth)
    assert error.value.code == csv_validation.GROUND_TRUTH_INVALID


def test_submission_duoc_can_theo_thu_tu_ground_truth_va_giu_cot_phu():
    schema = FileSchema(
        id_column="id",
        allow_extra_columns=True,
        columns=[
            ColumnSpec(name="id", type="integer"),
            ColumnSpec(name="prediction", type="string"),
        ],
    )
    truth = csv_validation.load_ground_truth(
        b"id,label\n2,0\n1,1\n", _schema().ground_truth.model_copy(update={"id_column": "id"})
    )
    prepared = csv_validation.prepare_submission(
        b"id,prediction,do_tin_cay\n1,1,0.9\n2,0,0.4\n", schema, truth
    )
    assert prepared == b"id,prediction,do_tin_cay\r\n2,0,0.4\r\n1,1,0.9\r\n"


def test_submission_thua_cot_bi_tu_choi_khi_schema_khong_cho_phep():
    schema = _schema().submission
    truth = csv_validation.load_ground_truth(_gt_csv(), _schema().ground_truth)
    with pytest.raises(ScoringValidationError) as error:
        csv_validation.prepare_submission(b"id,prediction,extra\na,1,2\nb,0,3\nc,1,4\n", schema, truth)
    assert error.value.code == csv_validation.SCHEMA_INVALID


def test_submission_tap_id_phai_khop_ground_truth():
    truth = csv_validation.load_ground_truth(_gt_csv(), _schema().ground_truth)
    with pytest.raises(ScoringValidationError) as error:
        csv_validation.prepare_submission(b"id,prediction\na,1\nb,0\n", _schema().submission, truth)
    assert error.value.code == csv_validation.ID_MISMATCH


def test_submission_id_trung_lap_va_gia_tri_ngoai_danh_sach():
    truth = csv_validation.load_ground_truth(_gt_csv(), _schema().ground_truth)
    with pytest.raises(ScoringValidationError) as duplicate:
        csv_validation.prepare_submission(b"id,prediction\na,1\na,0\nc,1\n", _schema().submission, truth)
    assert duplicate.value.code == csv_validation.DUPLICATE_IDS

    with pytest.raises(ScoringValidationError) as value:
        csv_validation.prepare_submission(b"id,prediction\na,1\nb,2\nc,1\n", _schema().submission, truth)
    assert value.value.code == csv_validation.VALUE_INVALID


def test_o_trong_chi_duoc_phep_khi_cot_nullable():
    schema = FileSchema(
        id_column="id",
        columns=[
            ColumnSpec(name="id", type="string"),
            ColumnSpec(name="prediction", type="string", nullable=True),
        ],
    )
    truth = csv_validation.load_ground_truth(_gt_csv(), _schema().ground_truth)
    assert csv_validation.prepare_submission(b"id,prediction\na,\nb,0\nc,1\n", schema, truth)

    strict = schema.model_copy(
        update={"columns": [schema.columns[0], ColumnSpec(name="prediction", type="string")]}
    )
    with pytest.raises(ScoringValidationError) as error:
        csv_validation.prepare_submission(b"id,prediction\na,\nb,0\nc,1\n", strict, truth)
    assert error.value.code == csv_validation.VALUE_INVALID


def test_cot_so_nguyen_tu_choi_dang_khong_chuan():
    schema = FileSchema(
        id_column="id",
        columns=[ColumnSpec(name="id", type="integer"), ColumnSpec(name="prediction", type="string")],
    )
    truth = csv_validation.load_ground_truth(_gt_csv(), _schema().ground_truth)
    for bad in ("1.0", "01", "+1", "một"):
        with pytest.raises(ScoringValidationError, match="số nguyên"):
            csv_validation.prepare_submission(
                f"id,prediction\n{bad},1\n2,0\n3,1\n".encode(), schema, truth
            )


def test_id_dinh_khoang_trang_bi_tu_choi():
    truth = csv_validation.load_ground_truth(_gt_csv(), _schema().ground_truth)
    with pytest.raises(ScoringValidationError, match="khoảng trắng"):
        csv_validation.prepare_submission(b"id,prediction\na ,1\nb,0\nc,1\n", _schema().submission, truth)


@pytest.mark.parametrize(
    ("data", "code", "message"),
    [
        (b"id;prediction\na;1\n", "SUBMISSION_SCHEMA_INVALID", "dấu phẩy"),
        (b"unrelated;header\na;1\n", "SUBMISSION_SCHEMA_INVALID", "Thiếu cột"),
        (b'id,prediction\na,"1\n', "SUBMISSION_SCHEMA_INVALID", "dấu nháy"),
        (b"id,prediction\na,1,extra\n", "SUBMISSION_SCHEMA_INVALID", "Dòng 2"),
        (b"id,prediction\na\n", "SUBMISSION_SCHEMA_INVALID", "Dòng 2"),
        (b"id,prediction\na,1\na,0\n", "SUBMISSION_DUPLICATE_IDS", "dòng 3"),
    ],
)
def test_submission_csv_diagnoses_structure_without_disclosing_values(data, code, message):
    truth = csv_validation.load_ground_truth(_gt_csv(), _schema().ground_truth)
    with pytest.raises(ScoringValidationError) as error:
        csv_validation.prepare_submission(data, _schema().submission, truth)
    assert error.value.code == code
    assert message in error.value.message
    assert "extra" not in error.value.message


def test_submission_csv_reports_physical_line_after_quoted_newline():
    schema = FileSchema(
        id_column="id",
        columns=[ColumnSpec(name="id", type="string"), ColumnSpec(name="prediction", type="string")],
    )
    truth = csv_validation.load_ground_truth(_gt_csv(), _schema().ground_truth)
    with pytest.raises(ScoringValidationError) as error:
        csv_validation.prepare_submission(
            b'id,prediction\na,"hello\nworld"\na,duplicate\n', schema, truth
        )
    assert error.value.code == "SUBMISSION_DUPLICATE_IDS"
    assert "dòng 4" in error.value.message
    assert "hello" not in error.value.message


def test_submission_csv_with_quoted_comma_is_valid():
    schema = FileSchema(
        id_column="id",
        columns=[ColumnSpec(name="id", type="string"), ColumnSpec(name="prediction", type="string")],
    )
    truth = csv_validation.load_ground_truth(_gt_csv(), _schema().ground_truth)
    assert csv_validation.prepare_submission(
        b'id,prediction\na,"hello,world"\nb,0\nc,1\n', schema, truth
    )
    assert csv_validation.prepare_submission(
        b'id,prediction\na,"hello\nworld"\nb,0\nc,1\n', schema, truth
    )


def test_csv_bom_va_crlf_doc_duoc():
    truth = csv_validation.load_ground_truth(
        "﻿id,label\r\na,1\r\nb,0\r\nc,1\r\n".encode(), _schema().ground_truth
    )
    assert truth.ids == ("a", "b", "c")


# --- output -----------------------------------------------------------------------------------


def test_validate_metrics_chi_nhan_so_huu_han_phang():
    assert validate_metrics({"f1": 1, "loss": 0.5}) == {"f1": 1.0, "loss": 0.5}
    for bad in ({}, {"f1": True}, {"f1": None}, {"f1": "1"}, {"f1": float("nan")}, {"f1": float("inf")}):
        with pytest.raises(ScoringValidationError) as error:
            validate_metrics(bad)
        assert error.value.code == "EVALUATOR_OUTPUT_MISMATCH"


def test_validate_metrics_noi_dung_bo_cham_da_tra_ve_gi():
    """Ba dạng sai phải ra ba câu khác nhau: admin nhìn thông báo là biết sửa gì trong evaluate."""
    with pytest.raises(ScoringValidationError, match="không trả về giá trị nào"):
        validate_metrics(None)
    with pytest.raises(ScoringValidationError, match="dictionary rỗng"):
        validate_metrics({})
    with pytest.raises(ScoringValidationError, match="trả về list"):
        validate_metrics([1.0])


def test_validate_metrics_tu_choi_gia_tri_long_nhau():
    with pytest.raises(ScoringValidationError):
        validate_metrics({"f1": {"a": 1}})


def test_check_contract_bao_thieu_va_thua():
    contract = _contract()
    check_contract({"accuracy": 1.0, "macro_f1": 1.0}, contract)
    with pytest.raises(ScoringValidationError, match="thiếu macro_f1"):
        check_contract({"accuracy": 1.0}, contract)
    with pytest.raises(ScoringValidationError, match="thừa khac"):
        check_contract({"accuracy": 1.0, "macro_f1": 1.0, "khac": 1.0}, contract)


def test_primary_score_lay_dung_metric_chinh_va_doi_hoi_da_chon():
    contract = _contract()
    assert primary_score({"accuracy": 0.2, "macro_f1": 0.7}, contract) == 0.7
    with pytest.raises(ScoringValidationError) as error:
        primary_score({"accuracy": 0.2}, _contract(primary_metric=None))
    assert error.value.code == "SCORING_TEST_REQUIRED"


# --- dấu vân tay ------------------------------------------------------------------------------


def _fingerprint(**overrides) -> str:
    values = {
        "input_schema": _schema(),
        "source_sha256": "source",
        "ground_truth_sha256": "truth",
        "runtime_id": "vku-evaluator-runtime:1",
    }
    values.update(overrides)
    return revisions.execution_fingerprint(**values)


def test_doi_bat_ky_dau_vao_nao_cung_doi_dau_van_tay():
    base = _fingerprint()
    assert base == _fingerprint()
    changed = {
        "source_sha256": "source2",
        "ground_truth_sha256": "truth2",
        "runtime_id": "vku-evaluator-runtime:2",
        "input_schema": _schema(
            submission=FileSchema(
                id_column="id",
                allow_extra_columns=True,
                columns=_schema().submission.columns,
            )
        ),
    }
    for field, value in changed.items():
        assert _fingerprint(**{field: value}) != base, field


def test_doi_trinh_bay_khong_mat_hieu_luc_doi_tap_khoa_thi_mat():
    execution = _fingerprint()
    contract = _contract()
    verification = Verification(
        state="passed",
        execution_fingerprint=execution,
        observed_keys=["accuracy", "macro_f1"],
    )
    assert revisions.verification_matches(verification, execution=execution, contract=contract)
    # Bản nháp dò khóa chưa khai hợp đồng: bằng chứng chỉ cần đúng phần đã chạy.
    assert revisions.verification_matches(verification, execution=execution, contract=None)

    # Trình bày kết quả không nằm trong bằng chứng: lượt chạy thử không quan sát được chúng, nên bắt
    # chạy lại vì chúng chỉ tạo thêm lượt chứ không thêm bằng chứng.
    for changed in (
        _contract(primary_metric="accuracy"),
        _contract(higher_is_better=False),
        _contract(
            metrics=[
                MetricDefinition(key="accuracy", label="Độ chính xác", decimals=2),
                MetricDefinition(key="macro_f1", label="Macro F1", decimals=4),
            ]
        ),
        _contract(visible_metrics=["accuracy"]),
    ):
        assert revisions.verification_matches(verification, execution=execution, contract=changed)

    # Tập khóa là thứ bộ chấm phải trả về: khai thừa hay khai thiếu đều làm bằng chứng cũ hết hiệu lực.
    for changed in (
        _contract(
            metrics=[MetricDefinition(key="accuracy", label="Accuracy", decimals=4)],
            primary_metric=None,
        ),
        _contract(metrics=[*_contract().metrics, MetricDefinition(key="f1_macro", label="Macro F1")]),
    ):
        assert not revisions.verification_matches(verification, execution=execution, contract=changed)


def test_verification_chua_chay_hoac_da_chay_voi_cau_hinh_khac():
    execution = _fingerprint()
    contract = _contract()
    assert not revisions.verification_matches(None, execution=execution, contract=contract)
    stale = Verification(
        state="passed",
        execution_fingerprint="khac",
        config_fingerprint=revisions.config_fingerprint(execution, contract),
    )
    assert not revisions.verification_matches(stale, execution=execution, contract=contract)
