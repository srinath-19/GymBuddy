from __future__ import annotations

# ---------------------------------------------------------------------------
# Exercise → muscle targets lookup table.
# Keys are lowercase, normalized exercise names (matching parser output).
# Each entry is a list of dicts matching MuscleTargetResponse shape.
# Source is always "lookup" here — the route sets "ai_inferred" for misses.
# ---------------------------------------------------------------------------
MUSCLE_LOOKUP: dict[str, list[dict]] = {
    # ── Chest ─────────────────────────────────────────────────────────────
    "bench press": [
        {"muscle_group": "chest", "specific_muscles": ["pectoralis major (sternal head)", "pectoralis major (clavicular head)"], "role": "primary"},
        {"muscle_group": "shoulders", "specific_muscles": ["anterior deltoid"], "role": "secondary"},
        {"muscle_group": "triceps", "specific_muscles": ["triceps brachii"], "role": "secondary"},
    ],
    "incline bench press": [
        {"muscle_group": "chest", "specific_muscles": ["pectoralis major (clavicular head)"], "role": "primary"},
        {"muscle_group": "shoulders", "specific_muscles": ["anterior deltoid"], "role": "secondary"},
        {"muscle_group": "triceps", "specific_muscles": ["triceps brachii"], "role": "secondary"},
    ],
    "decline bench press": [
        {"muscle_group": "chest", "specific_muscles": ["pectoralis major (sternal head)"], "role": "primary"},
        {"muscle_group": "triceps", "specific_muscles": ["triceps brachii"], "role": "secondary"},
    ],
    "dumbbell fly": [
        {"muscle_group": "chest", "specific_muscles": ["pectoralis major (sternal head)", "pectoralis major (clavicular head)"], "role": "primary"},
        {"muscle_group": "shoulders", "specific_muscles": ["anterior deltoid"], "role": "secondary"},
    ],
    "cable fly": [
        {"muscle_group": "chest", "specific_muscles": ["pectoralis major"], "role": "primary"},
        {"muscle_group": "shoulders", "specific_muscles": ["anterior deltoid"], "role": "secondary"},
    ],
    "push up": [
        {"muscle_group": "chest", "specific_muscles": ["pectoralis major"], "role": "primary"},
        {"muscle_group": "shoulders", "specific_muscles": ["anterior deltoid"], "role": "secondary"},
        {"muscle_group": "triceps", "specific_muscles": ["triceps brachii"], "role": "secondary"},
    ],
    # ── Back ──────────────────────────────────────────────────────────────
    "deadlift": [
        {"muscle_group": "back", "specific_muscles": ["erector spinae", "latissimus dorsi"], "role": "primary"},
        {"muscle_group": "glutes", "specific_muscles": ["gluteus maximus"], "role": "primary"},
        {"muscle_group": "hamstrings", "specific_muscles": ["biceps femoris", "semitendinosus"], "role": "secondary"},
        {"muscle_group": "traps", "specific_muscles": ["trapezius"], "role": "secondary"},
    ],
    "romanian deadlift": [
        {"muscle_group": "hamstrings", "specific_muscles": ["biceps femoris", "semitendinosus", "semimembranosus"], "role": "primary"},
        {"muscle_group": "glutes", "specific_muscles": ["gluteus maximus"], "role": "primary"},
        {"muscle_group": "back", "specific_muscles": ["erector spinae"], "role": "secondary"},
    ],
    "lat pull down": [
        {"muscle_group": "back", "specific_muscles": ["latissimus dorsi", "teres major"], "role": "primary"},
        {"muscle_group": "biceps", "specific_muscles": ["biceps brachii"], "role": "secondary"},
        {"muscle_group": "back", "specific_muscles": ["rhomboids", "rear deltoid"], "role": "secondary"},
    ],
    "lat pulldown": [
        {"muscle_group": "back", "specific_muscles": ["latissimus dorsi", "teres major"], "role": "primary"},
        {"muscle_group": "biceps", "specific_muscles": ["biceps brachii"], "role": "secondary"},
        {"muscle_group": "back", "specific_muscles": ["rhomboids", "rear deltoid"], "role": "secondary"},
    ],
    "pull up": [
        {"muscle_group": "back", "specific_muscles": ["latissimus dorsi", "teres major"], "role": "primary"},
        {"muscle_group": "biceps", "specific_muscles": ["biceps brachii"], "role": "secondary"},
        {"muscle_group": "back", "specific_muscles": ["rhomboids"], "role": "secondary"},
    ],
    "chin up": [
        {"muscle_group": "back", "specific_muscles": ["latissimus dorsi"], "role": "primary"},
        {"muscle_group": "biceps", "specific_muscles": ["biceps brachii"], "role": "primary"},
        {"muscle_group": "back", "specific_muscles": ["rhomboids"], "role": "secondary"},
    ],
    "barbell row": [
        {"muscle_group": "back", "specific_muscles": ["latissimus dorsi", "rhomboids", "erector spinae"], "role": "primary"},
        {"muscle_group": "biceps", "specific_muscles": ["biceps brachii"], "role": "secondary"},
        {"muscle_group": "shoulders", "specific_muscles": ["rear deltoid"], "role": "secondary"},
    ],
    "dumbbell row": [
        {"muscle_group": "back", "specific_muscles": ["latissimus dorsi", "rhomboids"], "role": "primary"},
        {"muscle_group": "biceps", "specific_muscles": ["biceps brachii"], "role": "secondary"},
        {"muscle_group": "shoulders", "specific_muscles": ["rear deltoid"], "role": "secondary"},
    ],
    "seated cable row": [
        {"muscle_group": "back", "specific_muscles": ["latissimus dorsi", "rhomboids", "erector spinae"], "role": "primary"},
        {"muscle_group": "biceps", "specific_muscles": ["biceps brachii"], "role": "secondary"},
        {"muscle_group": "shoulders", "specific_muscles": ["rear deltoid"], "role": "secondary"},
    ],
    # ── Shoulders ─────────────────────────────────────────────────────────
    "overhead press": [
        {"muscle_group": "shoulders", "specific_muscles": ["anterior deltoid", "lateral deltoid"], "role": "primary"},
        {"muscle_group": "triceps", "specific_muscles": ["triceps brachii"], "role": "secondary"},
        {"muscle_group": "traps", "specific_muscles": ["upper trapezius"], "role": "secondary"},
    ],
    "shoulder press": [
        {"muscle_group": "shoulders", "specific_muscles": ["anterior deltoid", "lateral deltoid"], "role": "primary"},
        {"muscle_group": "triceps", "specific_muscles": ["triceps brachii"], "role": "secondary"},
        {"muscle_group": "traps", "specific_muscles": ["upper trapezius"], "role": "secondary"},
    ],
    "lateral raise": [
        {"muscle_group": "shoulders", "specific_muscles": ["lateral deltoid"], "role": "primary"},
        {"muscle_group": "traps", "specific_muscles": ["upper trapezius"], "role": "secondary"},
    ],
    "front raise": [
        {"muscle_group": "shoulders", "specific_muscles": ["anterior deltoid"], "role": "primary"},
        {"muscle_group": "chest", "specific_muscles": ["pectoralis major (clavicular head)"], "role": "secondary"},
    ],
    "face pull": [
        {"muscle_group": "shoulders", "specific_muscles": ["rear deltoid"], "role": "primary"},
        {"muscle_group": "back", "specific_muscles": ["rhomboids", "lower trapezius"], "role": "secondary"},
    ],
    # ── Legs ──────────────────────────────────────────────────────────────
    "squat": [
        {"muscle_group": "quads", "specific_muscles": ["vastus lateralis", "vastus medialis", "rectus femoris"], "role": "primary"},
        {"muscle_group": "glutes", "specific_muscles": ["gluteus maximus"], "role": "primary"},
        {"muscle_group": "hamstrings", "specific_muscles": ["biceps femoris", "semitendinosus"], "role": "secondary"},
        {"muscle_group": "back", "specific_muscles": ["erector spinae"], "role": "secondary"},
    ],
    "leg press": [
        {"muscle_group": "quads", "specific_muscles": ["vastus lateralis", "vastus medialis", "rectus femoris"], "role": "primary"},
        {"muscle_group": "glutes", "specific_muscles": ["gluteus maximus"], "role": "secondary"},
        {"muscle_group": "hamstrings", "specific_muscles": ["biceps femoris"], "role": "secondary"},
    ],
    "leg extension": [
        {"muscle_group": "quads", "specific_muscles": ["rectus femoris", "vastus lateralis", "vastus medialis", "vastus intermedius"], "role": "primary"},
    ],
    "leg curl": [
        {"muscle_group": "hamstrings", "specific_muscles": ["biceps femoris", "semitendinosus", "semimembranosus"], "role": "primary"},
    ],
    "hip thrust": [
        {"muscle_group": "glutes", "specific_muscles": ["gluteus maximus", "gluteus medius"], "role": "primary"},
        {"muscle_group": "hamstrings", "specific_muscles": ["biceps femoris"], "role": "secondary"},
    ],
    "lunge": [
        {"muscle_group": "quads", "specific_muscles": ["rectus femoris", "vastus lateralis"], "role": "primary"},
        {"muscle_group": "glutes", "specific_muscles": ["gluteus maximus"], "role": "secondary"},
        {"muscle_group": "hamstrings", "specific_muscles": ["biceps femoris"], "role": "secondary"},
    ],
    "calf raise": [
        {"muscle_group": "calves", "specific_muscles": ["gastrocnemius", "soleus"], "role": "primary"},
    ],
    # ── Biceps ────────────────────────────────────────────────────────────
    "bicep curl": [
        {"muscle_group": "biceps", "specific_muscles": ["biceps brachii (long head)", "biceps brachii (short head)", "brachialis"], "role": "primary"},
        {"muscle_group": "forearms", "specific_muscles": ["brachioradialis"], "role": "secondary"},
    ],
    "biceps curl": [
        {"muscle_group": "biceps", "specific_muscles": ["biceps brachii (long head)", "biceps brachii (short head)", "brachialis"], "role": "primary"},
        {"muscle_group": "forearms", "specific_muscles": ["brachioradialis"], "role": "secondary"},
    ],
    "hammer curl": [
        {"muscle_group": "biceps", "specific_muscles": ["brachialis", "biceps brachii"], "role": "primary"},
        {"muscle_group": "forearms", "specific_muscles": ["brachioradialis"], "role": "primary"},
    ],
    "preacher curl": [
        {"muscle_group": "biceps", "specific_muscles": ["biceps brachii (short head)", "brachialis"], "role": "primary"},
    ],
    # ── Triceps ───────────────────────────────────────────────────────────
    "tricep pushdown": [
        {"muscle_group": "triceps", "specific_muscles": ["triceps brachii (lateral head)", "triceps brachii (medial head)"], "role": "primary"},
    ],
    "triceps pushdown": [
        {"muscle_group": "triceps", "specific_muscles": ["triceps brachii (lateral head)", "triceps brachii (medial head)"], "role": "primary"},
    ],
    "skull crusher": [
        {"muscle_group": "triceps", "specific_muscles": ["triceps brachii (long head)", "triceps brachii (lateral head)"], "role": "primary"},
    ],
    "tricep dip": [
        {"muscle_group": "triceps", "specific_muscles": ["triceps brachii"], "role": "primary"},
        {"muscle_group": "chest", "specific_muscles": ["pectoralis major (sternal head)"], "role": "secondary"},
        {"muscle_group": "shoulders", "specific_muscles": ["anterior deltoid"], "role": "secondary"},
    ],
    "overhead tricep extension": [
        {"muscle_group": "triceps", "specific_muscles": ["triceps brachii (long head)"], "role": "primary"},
    ],
    # ── Core ──────────────────────────────────────────────────────────────
    "plank": [
        {"muscle_group": "core", "specific_muscles": ["rectus abdominis", "transverse abdominis", "obliques"], "role": "primary"},
        {"muscle_group": "shoulders", "specific_muscles": ["anterior deltoid"], "role": "secondary"},
    ],
    "crunch": [
        {"muscle_group": "core", "specific_muscles": ["rectus abdominis"], "role": "primary"},
    ],
    "ab wheel": [
        {"muscle_group": "core", "specific_muscles": ["rectus abdominis", "transverse abdominis"], "role": "primary"},
        {"muscle_group": "shoulders", "specific_muscles": ["anterior deltoid"], "role": "secondary"},
    ],
}


def lookup_muscles(exercise: str) -> list[dict] | None:
    """Return muscle target dicts for a normalized exercise name, or None if not found."""
    return MUSCLE_LOOKUP.get(exercise.strip().lower())
