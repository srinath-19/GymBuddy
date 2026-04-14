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
from sqlalchemy.pool import NullPool

load_dotenv()

_raw_url: str = os.environ.get("DATABASE_URL", "")
if not _raw_url:
    raise RuntimeError(
        "DATABASE_URL is not set. "
        "Copy .env.example to .env and fill in your Supabase connection string."
    )

# Strip ?pgbouncer=true if present — that flag is Prisma-specific syntax.
# asyncpg doesn't accept it as a connect() argument and will raise TypeError.
# PgBouncer compatibility is configured below via connect_args instead.
DATABASE_URL = _raw_url.replace("?pgbouncer=true", "").replace("&pgbouncer=true", "")

# NullPool + statement_cache_size=0 is the correct asyncpg setup for PgBouncer
# in transaction mode:
#   - NullPool: disables SQLAlchemy's own connection pool so PgBouncer manages
#     connections exclusively (avoids conflicts with transaction-level pooling).
#   - statement_cache_size=0: tells asyncpg not to use server-side prepared
#     statements, which PgBouncer in transaction mode does not support.
engine = create_async_engine(
    DATABASE_URL,
    poolclass=NullPool,
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
