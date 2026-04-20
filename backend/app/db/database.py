from __future__ import annotations

import os
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from dotenv import load_dotenv
from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase
load_dotenv()

_raw_url: str = os.environ.get("DATABASE_URL", "")
if not _raw_url:
    raise RuntimeError(
        "DATABASE_URL is not set. "
        "Copy .env.example to .env and fill in your Supabase connection string."
    )

# Strip ?pgbouncer=true if present — that flag is Prisma-specific syntax.
DATABASE_URL = _raw_url.replace("?pgbouncer=true", "").replace("&pgbouncer=true", "")

# Pool settings for Supabase transaction pooler (PgBouncer, port 6543):
#   - statement_cache_size=0: disables asyncpg server-side prepared statements,
#     which PgBouncer transaction mode does not support.
#   - pool_size/max_overflow: SQLAlchemy holds open connections to PgBouncer so
#     each request reuses an existing connection instead of paying the full
#     TCP + SSL + auth handshake cost (~500ms on hosted Supabase) every time.
#   - pool_pre_ping: validates idle connections before use (handles Supabase
#     idle-connection timeouts without crashing).
#   - pool_recycle: proactively recycle connections every 5 min to stay ahead
#     of Supabase's server-side idle timeout.
engine = create_async_engine(
    DATABASE_URL,
    pool_size=5,
    max_overflow=5,
    pool_pre_ping=True,
    pool_recycle=300,
    connect_args={"statement_cache_size": 0},
    echo=False,  # set True to log SQL queries during development
)

AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,  # prevents DetachedInstanceError after session closes
)


class Base(DeclarativeBase):
    pass


@asynccontextmanager
async def get_session() -> AsyncGenerator[AsyncSession, None]:
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def create_tables() -> None:
    """Create tables if they don't exist. Called once at startup."""
    async with engine.begin() as conn:
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS workout_logs (
                id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id     UUID,
                exercise    VARCHAR(255) NOT NULL,
                sets        INTEGER NOT NULL,
                reps        INTEGER NOT NULL,
                weight      FLOAT NOT NULL,
                weight_unit VARCHAR(10) NOT NULL DEFAULT 'lbs',
                notes       TEXT,
                logged_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
        """))
        # Add user_id to existing deployments that predate auth
        await conn.execute(text("""
            ALTER TABLE workout_logs
                ADD COLUMN IF NOT EXISTS user_id UUID
        """))
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS workout_muscle_targets (
                id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                workout_id       UUID NOT NULL REFERENCES workout_logs(id) ON DELETE CASCADE,
                muscle_group     VARCHAR(100) NOT NULL,
                specific_muscles TEXT[] NOT NULL DEFAULT '{}',
                role             VARCHAR(20) NOT NULL DEFAULT 'primary',
                source           VARCHAR(20) NOT NULL DEFAULT 'lookup'
            )
        """))
        await conn.execute(text("""
            CREATE TABLE IF NOT EXISTS workout_sessions (
                id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                user_id      UUID NOT NULL,
                date         DATE NOT NULL,
                session_type TEXT NOT NULL,
                notes        TEXT,
                created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                UNIQUE (user_id, date)
            )
        """))
