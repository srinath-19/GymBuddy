from __future__ import annotations

import os

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import PyJWKClient

_jwks_url: str = os.environ.get("SUPABASE_JWKS_URL", "")
if not _jwks_url:
    raise RuntimeError(
        "SUPABASE_JWKS_URL is not set. "
        "Add it to your .env file: "
        "https://<project_ref>.supabase.co/auth/v1/.well-known/jwks.json"
    )

# Cache the JWKS key set; refresh at most every 15 minutes
_jwks_client = PyJWKClient(_jwks_url, cache_jwk_set=True, lifespan=900)
_bearer = HTTPBearer()


def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer),
) -> dict:
    """Validate a Supabase JWT and return its payload.

    payload["sub"] is the Supabase user UUID (str).
    """
    token = credentials.credentials
    try:
        signing_key = _jwks_client.get_signing_key_from_jwt(token)
        payload: dict = jwt.decode(
            token,
            signing_key.key,
            algorithms=["ES256", "RS256"],
            audience="authenticated",
        )
        return payload
    except jwt.ExpiredSignatureError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token expired",
        )
    except jwt.PyJWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token",
        )
