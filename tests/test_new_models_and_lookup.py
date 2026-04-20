"""
Tests for new GymBuddy models and functionality:
  - MuscleTargetResponse
  - WorkoutSession
  - AgentActionResponse
  - lookup_muscles() function
  - _rows_to_responses() helper
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone

import pytest
from pydantic import ValidationError

# ---------------------------------------------------------------------------
# Imports under test
# ---------------------------------------------------------------------------
from backend.app.models.workout import (
    AgentActionResponse,
    MuscleTargetResponse,
    WorkoutLogResponse,
    WorkoutSession,
)
from backend.app.data.muscle_lookup import lookup_muscles, MUSCLE_LOOKUP
from backend.app.db.queries import _rows_to_responses


# ---------------------------------------------------------------------------
# Helpers shared across tests
# ---------------------------------------------------------------------------

def make_workout_log_response(**overrides) -> WorkoutLogResponse:
    defaults = dict(
        id=uuid.uuid4(),
        user_id=uuid.uuid4(),
        exercise="bench press",
        sets=3,
        reps=10,
        weight=135.0,
        weight_unit="lbs",
        notes=None,
        logged_at=datetime.now(timezone.utc),
        created_at=datetime.now(timezone.utc),
    )
    defaults.update(overrides)
    return WorkoutLogResponse(**defaults)


def make_session(**overrides) -> WorkoutSession:
    defaults = dict(
        id=uuid.uuid4(),
        user_id=uuid.uuid4(),
        date=date.today(),
        session_type="chest",
        notes=None,
        created_at=datetime.now(timezone.utc),
    )
    defaults.update(overrides)
    return WorkoutSession(**defaults)


def make_row(**overrides) -> dict:
    """Construct a mock DB row dict suitable for _rows_to_responses."""
    defaults = dict(
        id=uuid.uuid4(),
        user_id=uuid.uuid4(),
        exercise="squat",
        sets=4,
        reps=8,
        weight=225.0,
        weight_unit="lbs",
        notes=None,
        logged_at=datetime.now(timezone.utc),
        created_at=datetime.now(timezone.utc),
        muscle_targets_json=[],
    )
    defaults.update(overrides)
    return defaults


# ===========================================================================
# MuscleTargetResponse
# ===========================================================================

class TestMuscleTargetResponse:

    def test_valid_primary_lookup(self):
        mt = MuscleTargetResponse(
            muscle_group="chest",
            specific_muscles=["pectoralis major"],
            role="primary",
            source="lookup",
        )
        assert mt.muscle_group == "chest"
        assert mt.role == "primary"
        assert mt.source == "lookup"
        assert mt.specific_muscles == ["pectoralis major"]

    def test_valid_secondary_ai_inferred(self):
        mt = MuscleTargetResponse(
            muscle_group="triceps",
            specific_muscles=["triceps brachii"],
            role="secondary",
            source="ai_inferred",
        )
        assert mt.role == "secondary"
        assert mt.source == "ai_inferred"

    def test_invalid_role_tertiary(self):
        with pytest.raises(ValidationError) as exc_info:
            MuscleTargetResponse(
                muscle_group="core",
                specific_muscles=["abs"],
                role="tertiary",
                source="lookup",
            )
        errors = exc_info.value.errors()
        assert any(e["loc"] == ("role",) for e in errors)

    def test_invalid_source_manual(self):
        with pytest.raises(ValidationError) as exc_info:
            MuscleTargetResponse(
                muscle_group="chest",
                specific_muscles=["pectoralis major"],
                role="primary",
                source="manual",
            )
        errors = exc_info.value.errors()
        assert any(e["loc"] == ("source",) for e in errors)

    def test_invalid_specific_muscles_not_a_list(self):
        with pytest.raises(ValidationError):
            MuscleTargetResponse(
                muscle_group="chest",
                specific_muscles="pectoralis major",  # string, not list
                role="primary",
                source="lookup",
            )

    def test_empty_specific_muscles_list_is_valid(self):
        """An empty list of specific muscles is structurally valid."""
        mt = MuscleTargetResponse(
            muscle_group="chest",
            specific_muscles=[],
            role="primary",
            source="lookup",
        )
        assert mt.specific_muscles == []

    def test_multiple_specific_muscles(self):
        muscles = ["pectoralis major (sternal head)", "pectoralis major (clavicular head)"]
        mt = MuscleTargetResponse(
            muscle_group="chest",
            specific_muscles=muscles,
            role="primary",
            source="ai_inferred",
        )
        assert len(mt.specific_muscles) == 2


# ===========================================================================
# WorkoutSession
# ===========================================================================

class TestWorkoutSession:

    def test_valid_all_fields_present(self):
        wid = uuid.uuid4()
        uid = uuid.uuid4()
        d = date(2024, 6, 15)
        ts = datetime(2024, 6, 15, 10, 0, 0, tzinfo=timezone.utc)
        ws = WorkoutSession(
            id=wid,
            user_id=uid,
            date=d,
            session_type="push",
            notes="focused on chest",
            created_at=ts,
        )
        assert ws.id == wid
        assert ws.user_id == uid
        assert ws.date == d
        assert ws.session_type == "push"
        assert ws.notes == "focused on chest"
        assert ws.created_at == ts

    def test_valid_notes_none(self):
        ws = make_session(notes=None)
        assert ws.notes is None

    def test_invalid_missing_id(self):
        with pytest.raises(ValidationError):
            WorkoutSession(
                user_id=uuid.uuid4(),
                date=date.today(),
                session_type="pull",
                notes=None,
                created_at=datetime.now(timezone.utc),
            )

    def test_invalid_missing_user_id(self):
        with pytest.raises(ValidationError):
            WorkoutSession(
                id=uuid.uuid4(),
                date=date.today(),
                session_type="pull",
                notes=None,
                created_at=datetime.now(timezone.utc),
            )

    def test_invalid_missing_date(self):
        with pytest.raises(ValidationError):
            WorkoutSession(
                id=uuid.uuid4(),
                user_id=uuid.uuid4(),
                session_type="legs",
                notes=None,
                created_at=datetime.now(timezone.utc),
            )

    def test_invalid_missing_session_type(self):
        with pytest.raises(ValidationError):
            WorkoutSession(
                id=uuid.uuid4(),
                user_id=uuid.uuid4(),
                date=date.today(),
                notes=None,
                created_at=datetime.now(timezone.utc),
            )

    def test_invalid_missing_created_at(self):
        with pytest.raises(ValidationError):
            WorkoutSession(
                id=uuid.uuid4(),
                user_id=uuid.uuid4(),
                date=date.today(),
                session_type="push",
                notes=None,
            )

    def test_session_type_arbitrary_string(self):
        """session_type has no literal constraint — any string is valid."""
        ws = make_session(session_type="upper/lower split A")
        assert ws.session_type == "upper/lower split A"


# ===========================================================================
# AgentActionResponse
# ===========================================================================

class TestAgentActionResponse:

    def test_valid_logged_with_workout(self):
        workout = make_workout_log_response()
        resp = AgentActionResponse(
            action="logged",
            message="Bench press logged.",
            workout=workout,
        )
        assert resp.action == "logged"
        assert resp.workout is not None
        assert resp.workouts is None
        assert resp.session is None

    def test_valid_found_with_workouts_list(self):
        workouts = [make_workout_log_response(), make_workout_log_response(exercise="squat")]
        resp = AgentActionResponse(
            action="found",
            message="Found 2 workouts.",
            workouts=workouts,
        )
        assert resp.action == "found"
        assert len(resp.workouts) == 2
        assert resp.workout is None

    def test_valid_session_started_with_session(self):
        session = make_session(session_type="chest")
        resp = AgentActionResponse(
            action="session_started",
            message="Chest day started.",
            session=session,
        )
        assert resp.action == "session_started"
        assert resp.session is not None
        assert resp.session.session_type == "chest"

    def test_valid_deleted_all_none(self):
        """action='deleted' with no workout/workouts/session populated is valid."""
        resp = AgentActionResponse(
            action="deleted",
            message="Last workout deleted.",
        )
        assert resp.action == "deleted"
        assert resp.workout is None
        assert resp.workouts is None
        assert resp.session is None

    def test_valid_updated_with_workout(self):
        workout = make_workout_log_response(sets=4)
        resp = AgentActionResponse(
            action="updated",
            message="Sets updated to 4.",
            workout=workout,
        )
        assert resp.action == "updated"
        assert resp.workout.sets == 4

    def test_valid_none_action(self):
        resp = AgentActionResponse(
            action="none",
            message="I didn't understand that.",
        )
        assert resp.action == "none"
        assert resp.message == "I didn't understand that."

    def test_invalid_unknown_action(self):
        with pytest.raises(ValidationError) as exc_info:
            AgentActionResponse(
                action="unknown_action",
                message="Something happened.",
            )
        errors = exc_info.value.errors()
        assert any(e["loc"] == ("action",) for e in errors)

    def test_all_optional_fields_default_to_none(self):
        resp = AgentActionResponse(action="none", message="ok")
        assert resp.workout is None
        assert resp.workouts is None
        assert resp.session is None

    def test_deleted_with_workouts_list_bulk(self):
        """Bulk delete can populate workouts list."""
        workouts = [make_workout_log_response(), make_workout_log_response()]
        resp = AgentActionResponse(
            action="deleted",
            message="Deleted 2 bench press entries.",
            workouts=workouts,
        )
        assert resp.action == "deleted"
        assert len(resp.workouts) == 2


# ===========================================================================
# lookup_muscles function
# ===========================================================================

class TestLookupMuscles:

    def test_bench_press_returns_three_groups(self):
        result = lookup_muscles("bench press")
        assert result is not None
        assert len(result) == 3

    def test_bench_press_primary_is_chest(self):
        result = lookup_muscles("bench press")
        primary_groups = [entry for entry in result if entry["role"] == "primary"]
        assert len(primary_groups) == 1
        assert primary_groups[0]["muscle_group"] == "chest"

    def test_bench_press_secondary_groups(self):
        result = lookup_muscles("bench press")
        secondary_groups = [entry for entry in result if entry["role"] == "secondary"]
        secondary_names = {e["muscle_group"] for e in secondary_groups}
        assert "shoulders" in secondary_names
        assert "triceps" in secondary_names

    def test_squat_returns_four_groups(self):
        result = lookup_muscles("squat")
        assert result is not None
        assert len(result) == 4

    def test_squat_has_primary_quads_and_glutes(self):
        result = lookup_muscles("squat")
        primary_groups = {e["muscle_group"] for e in result if e["role"] == "primary"}
        assert "quads" in primary_groups
        assert "glutes" in primary_groups

    def test_squat_has_secondary_hamstrings_and_back(self):
        result = lookup_muscles("squat")
        secondary_groups = {e["muscle_group"] for e in result if e["role"] == "secondary"}
        assert "hamstrings" in secondary_groups
        assert "back" in secondary_groups

    def test_case_insensitive_bench_press_upper(self):
        result_lower = lookup_muscles("bench press")
        result_upper = lookup_muscles("Bench Press")
        assert result_upper == result_lower

    def test_case_insensitive_squat_all_caps(self):
        result_lower = lookup_muscles("squat")
        result_upper = lookup_muscles("SQUAT")
        assert result_upper == result_lower

    def test_case_insensitive_mixed_case(self):
        result = lookup_muscles("DeAdLiFt")
        assert result is not None
        assert len(result) > 0

    def test_leading_trailing_whitespace_stripped(self):
        result_padded = lookup_muscles("  bench press  ")
        result_clean = lookup_muscles("bench press")
        assert result_padded == result_clean

    def test_whitespace_only_around_squat(self):
        result = lookup_muscles("\t squat \n")
        assert result is not None

    def test_unknown_exercise_returns_none(self):
        result = lookup_muscles("dragon punch press")
        assert result is None

    def test_unknown_exercise_does_not_raise(self):
        try:
            lookup_muscles("this exercise does not exist xyz123")
        except Exception as exc:
            pytest.fail(f"lookup_muscles raised an exception for unknown exercise: {exc}")

    def test_empty_string_returns_none(self):
        result = lookup_muscles("")
        assert result is None

    def test_whitespace_only_string_returns_none(self):
        """Whitespace-only string strips to '' which is not a valid key."""
        result = lookup_muscles("   ")
        assert result is None

    def test_lookup_table_has_at_least_39_exercises(self):
        assert len(MUSCLE_LOOKUP) >= 39

    def test_all_entries_have_required_keys(self):
        required_keys = {"muscle_group", "specific_muscles", "role"}
        for exercise, entries in MUSCLE_LOOKUP.items():
            for entry in entries:
                missing = required_keys - set(entry.keys())
                assert not missing, f"Exercise '{exercise}' entry missing keys: {missing}"

    def test_all_roles_valid(self):
        valid_roles = {"primary", "secondary"}
        for exercise, entries in MUSCLE_LOOKUP.items():
            for entry in entries:
                assert entry["role"] in valid_roles, (
                    f"Exercise '{exercise}' has invalid role: {entry['role']}"
                )

    def test_specific_exercises_exist(self):
        expected = [
            "bench press", "squat", "deadlift", "lat pulldown", "overhead press",
            "bicep curl", "tricep pushdown", "plank",
        ]
        for name in expected:
            assert name in MUSCLE_LOOKUP, f"Expected '{name}' in MUSCLE_LOOKUP"


# ===========================================================================
# _rows_to_responses helper
# ===========================================================================

class TestRowsToResponses:

    def test_empty_list_returns_empty_list(self):
        result = _rows_to_responses([])
        assert result == []

    def test_single_row_empty_muscle_targets_json(self):
        row = make_row(muscle_targets_json=[])
        result = _rows_to_responses([row])
        assert len(result) == 1
        assert isinstance(result[0], WorkoutLogResponse)
        assert result[0].muscle_targets == []

    def test_single_row_none_muscle_targets_json(self):
        """None for muscle_targets_json should yield empty muscle_targets list."""
        row = make_row(muscle_targets_json=None)
        result = _rows_to_responses([row])
        assert len(result) == 1
        assert result[0].muscle_targets == []

    def test_single_row_with_two_muscle_targets(self):
        mt1 = {"muscle_group": "chest", "specific_muscles": ["pectoralis major"], "role": "primary", "source": "lookup"}
        mt2 = {"muscle_group": "triceps", "specific_muscles": ["triceps brachii"], "role": "secondary", "source": "lookup"}
        row = make_row(muscle_targets_json=[mt1, mt2])
        result = _rows_to_responses([row])
        assert len(result) == 1
        assert len(result[0].muscle_targets) == 2
        assert isinstance(result[0].muscle_targets[0], MuscleTargetResponse)
        assert isinstance(result[0].muscle_targets[1], MuscleTargetResponse)

    def test_muscle_target_fields_preserved(self):
        mt = {
            "muscle_group": "quads",
            "specific_muscles": ["vastus lateralis", "vastus medialis"],
            "role": "primary",
            "source": "ai_inferred",
        }
        row = make_row(muscle_targets_json=[mt])
        result = _rows_to_responses([row])
        target = result[0].muscle_targets[0]
        assert target.muscle_group == "quads"
        assert target.specific_muscles == ["vastus lateralis", "vastus medialis"]
        assert target.role == "primary"
        assert target.source == "ai_inferred"

    def test_row_fields_mapped_correctly(self):
        wid = uuid.uuid4()
        uid = uuid.uuid4()
        ts = datetime(2024, 1, 15, 12, 0, 0, tzinfo=timezone.utc)
        row = make_row(
            id=wid,
            user_id=uid,
            exercise="deadlift",
            sets=5,
            reps=5,
            weight=315.0,
            weight_unit="lbs",
            notes="felt strong",
            logged_at=ts,
            created_at=ts,
            muscle_targets_json=[],
        )
        result = _rows_to_responses([row])
        r = result[0]
        assert r.id == wid
        assert r.user_id == uid
        assert r.exercise == "deadlift"
        assert r.sets == 5
        assert r.reps == 5
        assert r.weight == 315.0
        assert r.weight_unit == "lbs"
        assert r.notes == "felt strong"

    def test_multiple_rows(self):
        rows = [
            make_row(exercise="bench press"),
            make_row(exercise="squat"),
            make_row(exercise="deadlift"),
        ]
        result = _rows_to_responses(rows)
        assert len(result) == 3
        exercises = [r.exercise for r in result]
        assert "bench press" in exercises
        assert "squat" in exercises
        assert "deadlift" in exercises

    def test_row_with_null_user_id(self):
        """user_id is nullable per the model (UUID | None)."""
        row = make_row(user_id=None)
        result = _rows_to_responses([row])
        assert len(result) == 1
        assert result[0].user_id is None

    def test_is_personal_record_defaults_false(self):
        """_rows_to_responses does not set is_personal_record — should default False."""
        row = make_row()
        result = _rows_to_responses([row])
        assert result[0].is_personal_record is False

    def test_muscle_target_primary_role_preserved(self):
        mt = {"muscle_group": "back", "specific_muscles": ["latissimus dorsi"], "role": "primary", "source": "lookup"}
        row = make_row(muscle_targets_json=[mt])
        result = _rows_to_responses([row])
        assert result[0].muscle_targets[0].role == "primary"

    def test_muscle_target_secondary_role_preserved(self):
        mt = {"muscle_group": "biceps", "specific_muscles": ["biceps brachii"], "role": "secondary", "source": "ai_inferred"}
        row = make_row(muscle_targets_json=[mt])
        result = _rows_to_responses([row])
        assert result[0].muscle_targets[0].role == "secondary"
