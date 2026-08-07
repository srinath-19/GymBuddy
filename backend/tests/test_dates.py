"""
Tests for backend/app/utils/dates.py — the timezone/calendar-date boundary.

These guard the bug where a workout added for a chosen calendar date was stored
at UTC midnight and therefore rendered a day early for every user west of UTC.
"""
from __future__ import annotations

from datetime import date as Date, datetime, timezone

import pytest

from backend.app.utils.dates import (
    anchor_local_date,
    local_date_of,
    local_today,
    safe_tz,
)

# Spans the full offset range in use: UTC+14 down to UTC-11.
ZONES = [
    "Pacific/Kiritimati",   # +14
    "Asia/Kolkata",         # +5:30
    "UTC",
    "America/New_York",     # -4 / -5
    "America/Los_Angeles",  # -7 / -8
    "Pacific/Niue",         # -11
]


class TestAnchorLocalDate:
    @pytest.mark.parametrize("tz", ZONES)
    @pytest.mark.parametrize("day", [Date(2026, 1, 1), Date(2026, 8, 6), Date(2026, 12, 31)])
    def test_round_trips_to_the_same_calendar_day(self, tz: str, day: Date) -> None:
        """The stored instant must read back as the date the user picked."""
        assert local_date_of(anchor_local_date(day, tz), tz) == day.isoformat()

    @pytest.mark.parametrize("day", [Date(2026, 3, 8), Date(2026, 11, 1)])
    def test_round_trips_across_dst_transitions(self, day: Date) -> None:
        """US DST shifts happen at ~2am; a midday anchor must be unaffected."""
        tz = "America/New_York"
        assert local_date_of(anchor_local_date(day, tz), tz) == day.isoformat()

    def test_result_is_utc(self) -> None:
        anchored = anchor_local_date(Date(2026, 8, 6), "America/Denver")
        assert anchored.tzinfo is timezone.utc

    def test_utc_midnight_would_have_regressed(self) -> None:
        """Pin the actual bug: UTC midnight reads back as the previous day west of UTC."""
        tz = "America/Denver"
        naive_utc_midnight = datetime(2026, 8, 6, 0, 0, tzinfo=timezone.utc)
        assert local_date_of(naive_utc_midnight, tz) == "2026-08-05"
        assert local_date_of(anchor_local_date(Date(2026, 8, 6), tz), tz) == "2026-08-06"

    @pytest.mark.parametrize("tz", [None, "", "Not/AZone", "garbage"])
    def test_unknown_zone_falls_back_to_utc(self, tz: str | None) -> None:
        assert anchor_local_date(Date(2026, 8, 6), tz) == datetime(
            2026, 8, 6, 12, 0, tzinfo=timezone.utc
        )


class TestSafeTz:
    @pytest.mark.parametrize("tz", ZONES)
    def test_passes_through_valid_zones(self, tz: str) -> None:
        assert safe_tz(tz) == tz

    @pytest.mark.parametrize("tz", [None, "", "Not/AZone", "garbage", "America/Nowhere"])
    def test_rejects_invalid_zones(self, tz: str | None) -> None:
        # Postgres AT TIME ZONE errors on unknown names, so this must never pass one through.
        assert safe_tz(tz) == "UTC"


class TestLocalDateOf:
    def test_accepts_iso_strings(self) -> None:
        # Cached workouts are serialized to JSON, so logged_at arrives as a string.
        assert local_date_of("2026-08-06T02:00:00+00:00", "America/Denver") == "2026-08-05"

    def test_accepts_datetimes(self) -> None:
        moment = datetime(2026, 8, 6, 2, 0, tzinfo=timezone.utc)
        assert local_date_of(moment, "America/Denver") == "2026-08-05"

    def test_malformed_input_degrades_to_leading_date(self) -> None:
        assert local_date_of("2026-08-06 garbage", "UTC") == "2026-08-06"


class TestLocalToday:
    @pytest.mark.parametrize("tz", ZONES)
    def test_matches_the_zones_own_clock(self, tz: str) -> None:
        from zoneinfo import ZoneInfo

        assert local_today(tz) == datetime.now(ZoneInfo(tz)).date()

    def test_unknown_zone_falls_back_to_utc(self) -> None:
        assert local_today("Not/AZone") == datetime.now(timezone.utc).date()
