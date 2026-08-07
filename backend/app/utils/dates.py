"""Timezone-aware calendar-date helpers.

`workout_logs.logged_at` is a TIMESTAMPTZ — an instant — but users think in
calendar days, and the UI groups history by the *local* day. Converting between
the two is the job of this module; every path that turns a "YYYY-MM-DD" into a
stored instant (or back) must go through here so the manual, agent, and query
paths agree.
"""

from __future__ import annotations

from datetime import date as Date, datetime, time, timezone, tzinfo
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

# Workouts logged for an explicit calendar date are anchored at local midday
# rather than local midnight. Midnight sits within an hour of a DST transition
# and only a few hours from a neighbouring timezone, so either can push the
# instant across a day boundary; noon leaves ~12h of slack in both directions.
ANCHOR_HOUR = 12


def _zone(tz_name: str | None) -> tzinfo:
    """Resolve an IANA name to a tzinfo, falling back to UTC.

    Also catches the case where the tz database itself is missing (bare Windows
    without the `tzdata` package), which makes even ZoneInfo("UTC") raise.
    """
    if tz_name:
        try:
            return ZoneInfo(tz_name)
        except (ZoneInfoNotFoundError, KeyError, ValueError):
            pass
    return timezone.utc


def safe_tz(tz_name: str | None) -> str:
    """Return tz_name if it is a valid IANA timezone, else 'UTC'.

    Use this for values handed to Postgres' `AT TIME ZONE`, which errors on an
    unknown zone name rather than falling back.
    """
    if not tz_name:
        return "UTC"
    try:
        ZoneInfo(tz_name)
        return tz_name
    except (ZoneInfoNotFoundError, KeyError, ValueError):
        return "UTC"


def local_today(tz_name: str | None) -> Date:
    """The current calendar date in the given timezone."""
    return datetime.now(_zone(tz_name)).date()


def local_date_of(moment: datetime | str, tz_name: str | None) -> str:
    """Local calendar date (YYYY-MM-DD) of an instant, given as a datetime or ISO string."""
    try:
        dt = datetime.fromisoformat(moment) if isinstance(moment, str) else moment
        return dt.astimezone(_zone(tz_name)).date().isoformat()
    except (TypeError, ValueError):
        # Best effort for malformed input: the leading date of the raw string.
        return str(moment)[:10]


def anchor_local_date(day: Date, tz_name: str | None) -> datetime:
    """Turn a local calendar date into the UTC instant to store for it.

    The result reads back as `day` for anyone viewing in `tz_name`, which is what
    makes the day-grouped history line up with the date the user picked.
    """
    anchored = datetime.combine(day, time(ANCHOR_HOUR), tzinfo=_zone(tz_name))
    return anchored.astimezone(timezone.utc)
