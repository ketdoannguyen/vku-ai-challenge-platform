"""Pure CSV validation and classification metric tests for Sprint 05."""

import warnings

import pytest

from app.scoring import service as scoring_service
from app.scoring.service import (
    ScoringConfig,
    ScoringValidationError,
    load_ground_truth,
    score_submission,
    validate_config,
)


def _binary_config(**overrides) -> ScoringConfig:
    values = {
        "id_column": "id",
        "prediction_column": "prediction",
        "label_column": "label",
        "average": "binary",
        "pos_label": "1",
        "higher_is_better": True,
    }
    values.update(overrides)
    return ScoringConfig(**values)


def test_binary_metrics_perfect_and_fp_fn_fixture():
    config = _binary_config()
    ground_truth = load_ground_truth(b"id,label\n1,1\n2,1\n3,0\n4,0\n", config)

    perfect = score_submission(
        b"id,prediction\n1,1\n2,1\n3,0\n4,0\n",
        ground_truth,
        config,
        "f1",
    )
    assert perfect.metrics == {"f1": 1.0, "precision": 1.0, "recall": 1.0}
    assert perfect.primary_score == 1.0

    mixed = score_submission(
        b"id,prediction\n1,1\n2,0\n3,1\n4,0\n",
        ground_truth,
        config,
        "precision",
    )
    assert mixed.metrics == {"f1": 0.5, "precision": 0.5, "recall": 0.5}
    assert mixed.primary_score == 0.5


def test_submission_is_aligned_by_id_instead_of_row_order():
    config = _binary_config()
    ground_truth = load_ground_truth(b"id,label\na,1\nb,0\nc,1\n", config)
    ordered = score_submission(
        b"id,prediction\na,1\nb,0\nc,0\n", ground_truth, config, "recall"
    )
    reordered = score_submission(
        b"id,prediction\nc,0\na,1\nb,0\n", ground_truth, config, "recall"
    )
    assert reordered == ordered


def test_macro_metrics_fixture():
    config = _binary_config(average="macro", pos_label=None)
    ground_truth = load_ground_truth(
        b"sample,target\n1,cat\n2,dog\n3,bird\n4,bird\n",
        ScoringConfig(
            id_column="sample",
            prediction_column="answer",
            label_column="target",
            average="macro",
            pos_label=None,
            higher_is_better=True,
        ),
    )
    result = score_submission(
        b"sample,answer\n1,cat\n2,bird\n3,bird\n4,dog\n",
        ground_truth,
        ScoringConfig(
            id_column="sample",
            prediction_column="answer",
            label_column="target",
            average="macro",
            pos_label=None,
            higher_is_better=True,
        ),
        "f1",
    )
    assert result.metrics == {"f1": 0.5, "precision": 0.5, "recall": 0.5}


def test_zero_division_returns_zero_without_metric_warning():
    config = _binary_config()
    ground_truth = load_ground_truth(b"id,label\n1,1\n2,1\n3,0\n4,0\n", config)
    with warnings.catch_warnings(record=True) as caught:
        result = score_submission(
            b"id,prediction\n1,0\n2,0\n3,0\n4,0\n", ground_truth, config, "precision"
        )
    assert result.metrics == {"f1": 0.0, "precision": 0.0, "recall": 0.0}
    assert caught == []


def test_ground_truth_rejects_unreasonable_row_count(monkeypatch):
    monkeypatch.setattr(scoring_service, "MAX_CSV_ROWS", 2)
    with pytest.raises(ScoringValidationError) as exc_info:
        load_ground_truth(b"id,label\n1,1\n2,0\n3,1\n", _binary_config())
    assert exc_info.value.code == "GROUND_TRUTH_INVALID"
    assert "2 dòng" in exc_info.value.message


@pytest.mark.parametrize(
    ("csv_data", "expected_code"),
    [
        (b"id,wrong\n1,1\n2,0\n", "SUBMISSION_SCHEMA_INVALID"),
        (b"id,prediction\n1,1\n1,0\n", "SUBMISSION_DUPLICATE_IDS"),
        (b"id,prediction\n1,1\n", "SUBMISSION_ID_MISMATCH"),
        (b"id,prediction\n1,1\n2,0\n3,1\n", "SUBMISSION_ID_MISMATCH"),
        (b"id,prediction\n1,\n2,0\n", "SUBMISSION_VALUE_INVALID"),
        (b"id,prediction\n1,other\n2,0\n", "SUBMISSION_VALUE_INVALID"),
    ],
)
def test_submission_validation_rejects_invalid_csv(csv_data, expected_code):
    config = _binary_config()
    ground_truth = load_ground_truth(b"id,label\n1,1\n2,0\n", config)
    with pytest.raises(ScoringValidationError) as exc_info:
        score_submission(csv_data, ground_truth, config, "f1")
    assert exc_info.value.code == expected_code


@pytest.mark.parametrize(
    "csv_data",
    [
        b"",
        b"id,label\n",
        b"id,label\n1,\n",
        b"id,label\n1,1\n1,0\n",
        b"wrong,label\n1,1\n",
        b"\xff\xfe",
    ],
)
def test_ground_truth_rejects_empty_unreadable_or_invalid_data(csv_data):
    with pytest.raises(ScoringValidationError) as exc_info:
        load_ground_truth(csv_data, _binary_config())
    assert exc_info.value.code == "GROUND_TRUTH_INVALID"


@pytest.mark.parametrize(
    "config",
    [
        _binary_config(id_column=""),
        _binary_config(prediction_column="id"),
        _binary_config(average="micro"),
        _binary_config(pos_label=None),
        _binary_config(higher_is_better=False),
        _binary_config(average="macro", pos_label="1"),
    ],
)
def test_scoring_config_validation(config):
    with pytest.raises(ScoringValidationError) as exc_info:
        validate_config(config)
    assert exc_info.value.code == "SCORING_CONFIG_INVALID"
