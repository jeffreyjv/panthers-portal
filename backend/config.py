"""Environment configuration, loaded from `backend/.env` when present.

Importing this module populates `os.environ` from the .env file, so it has to
be imported before anything reads a variable at module level. Hand-rolled
rather than pulling in python-dotenv, for the same reason `sources.py` builds
its own HTTP calls instead of depending on requests: the whole job is a dozen
lines.

Values already in the real environment always win, so Render's dashboard
settings are never shadowed by a stray .env that got into an image.
"""

import os
from pathlib import Path

ENV_FILE = Path(__file__).resolve().parent / ".env"


def _load_env_file(path: Path = ENV_FILE) -> None:
    if not path.is_file():
        return

    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip()

        # Tolerate quoted values; a Neon URL pasted from the dashboard often
        # arrives wrapped in quotes.
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]

        os.environ.setdefault(key, value)


_load_env_file()


class ConfigError(RuntimeError):
    """A required setting is missing. Raised at startup, never per-request."""


def require(name: str) -> str:
    """A setting with no sensible default.

    Fails at startup rather than on the first request that needs it: a missing
    client secret should stop the deploy, not surface as a 500 the first time
    someone tries to sign in.
    """
    value = os.getenv(name, "").strip()
    if not value:
        raise ConfigError(
            f"{name} is not set. Add it to backend/.env for local development, "
            f"or to the service's environment in production."
        )
    return value


def flag(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")
