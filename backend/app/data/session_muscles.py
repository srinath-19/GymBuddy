from __future__ import annotations

# Maps normalized session_type label → expected primary muscle groups.
# Lookup normalizes to lowercase before matching.

SESSION_MUSCLE_MAP: dict[str, list[str]] = {
    # Push
    "push":                 ["chest", "shoulders", "triceps"],
    # Pull
    "pull":                 ["back", "biceps"],
    # Legs / Lower
    "legs":                 ["quads", "hamstrings", "glutes", "calves"],
    "lower":                ["quads", "hamstrings", "glutes", "calves"],
    # Chest-focused
    "chest":                ["chest", "triceps"],
    "chest day":            ["chest", "triceps"],
    "chest and triceps":    ["chest", "triceps"],
    # Back-focused
    "back":                 ["back", "biceps"],
    "back day":             ["back", "biceps"],
    "back and biceps":      ["back", "biceps"],
    "back and bis":         ["back", "biceps"],
    # Shoulders
    "shoulders":            ["shoulders", "traps"],
    "shoulder day":         ["shoulders", "traps"],
    "delts":                ["shoulders", "traps"],
    "shoulders and traps":  ["shoulders", "traps"],
    # Arms
    "arms":                 ["biceps", "triceps"],
    "arm day":              ["biceps", "triceps"],
    "bis and tris":         ["biceps", "triceps"],
    "biceps and triceps":   ["biceps", "triceps"],
    # Upper body
    "upper":                ["chest", "back", "shoulders", "biceps", "triceps"],
    "upper body":           ["chest", "back", "shoulders", "biceps", "triceps"],
    # Full body
    "full body":            ["chest", "back", "shoulders", "quads", "hamstrings", "glutes"],
    "full":                 ["chest", "back", "shoulders", "quads", "hamstrings", "glutes"],
    # Core
    "core":                 ["core"],
    "abs":                  ["core"],
    "ab day":               ["core"],
}

# Aliases: non-standard labels → canonical keys above.
SESSION_ALIASES: dict[str, str] = {
    "leg day":      "legs",
    "leg":          "legs",
    "shoulder":     "shoulders",
    "delt":         "delts",
    "arm":          "arms",
    "bis":          "arms",
    "tris":         "arms",
    "pushing":      "push",
    "pulling":      "pull",
    "pushing day":  "push",
    "pulling day":  "pull",
    "back bi":      "back and biceps",
    "back bis":     "back and biceps",
    "chest tri":    "chest and triceps",
    "chest tris":   "chest and triceps",
}


def get_expected_muscles(session_type: str) -> list[str]:
    """Return expected muscle groups for a session type label. Empty list if unrecognized."""
    key = session_type.strip().lower()
    resolved = SESSION_ALIASES.get(key, key)
    return SESSION_MUSCLE_MAP.get(resolved, [])
