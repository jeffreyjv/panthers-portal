"""Google sign-in and session handling.

Reading the Talk tab needs no account; posting, replying and reacting do.

The OAuth authorization-code flow is written out by hand over `urllib`, the
same way `sources.py` talks to its upstreams. That is a deliberate trade: by
reading the profile from Google's userinfo endpoint instead of decoding the
`id_token`, this module never has to verify a JWT signature, and the app needs
no cryptography dependency. The token exchange is a server-to-server HTTPS call
authenticated with the client secret, so its response is already trusted — a
signature would be checking Google's work against Google.

Sessions are opaque random tokens in a database table, not signed cookies:
signing out actually revokes, and there is no secret whose rotation would
invalidate every session at once.
"""

import json
import logging
import secrets
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Optional

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse

import config
import db
from models import CurrentUser

logger = logging.getLogger(__name__)

AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo"

# Name and email only. Both are non-sensitive scopes, which is why the consent
# screen can be published without a Google verification review.
SCOPES = "openid email profile"

SESSION_COOKIE = "panthers_session"
STATE_COOKIE = "panthers_oauth_state"
_STATE_MAX_AGE = 600  # The consent screen is a few clicks; ten minutes is ample.
_HTTP_TIMEOUT_SECONDS = 10

router = APIRouter(prefix="/api/auth", tags=["auth"])


def _secure_cookies() -> bool:
    """Whether cookies get the Secure flag.

    Off for local http development, on everywhere else — a Secure cookie is
    silently dropped over plain http, which looks exactly like a broken login.
    """
    return config.flag("SESSION_COOKIE_SECURE", default=True)


def redirect_uri() -> str:
    """Must byte-match a URI registered in the Google console."""
    base = config.require("APP_BASE_URL").rstrip("/")
    return f"{base}/api/auth/google/callback"


def _post_form(url: str, fields: Dict[str, str]) -> Dict[str, Any]:
    data = urllib.parse.urlencode(fields).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=_HTTP_TIMEOUT_SECONDS) as response:
        return json.loads(response.read().decode("utf-8"))


def _get_json(url: str, access_token: str) -> Dict[str, Any]:
    request = urllib.request.Request(
        url, headers={"Authorization": f"Bearer {access_token}"}
    )
    with urllib.request.urlopen(request, timeout=_HTTP_TIMEOUT_SECONDS) as response:
        return json.loads(response.read().decode("utf-8"))


# --- Dependencies ------------------------------------------------------------
def current_user(
    panthers_session: Optional[str] = Cookie(default=None),
) -> Optional[CurrentUser]:
    """Whoever is signed in, or None. Never raises.

    Being signed out is an ordinary state for a reader, not an error, so this
    stays quiet and lets each route decide whether it needs an account.
    """
    if not panthers_session:
        return None

    try:
        row = db.session_user(panthers_session)
    except Exception:
        # A database blip should log you out for the moment, not 500 the feed.
        logger.exception("Session lookup failed")
        return None

    if row is None or row["is_banned"]:
        return None

    return CurrentUser(
        id=row["id"],
        display_name=row["display_name"],
        avatar_url=row["avatar_url"],
        email=row["email"],
    )


def require_user(user: Optional[CurrentUser] = Depends(current_user)) -> CurrentUser:
    """Gate for every write route."""
    if user is None:
        raise HTTPException(status_code=401, detail="Sign in to do that")
    return user


# --- Routes ------------------------------------------------------------------
@router.get("/google")
def start_google_login() -> RedirectResponse:
    """Send the browser to Google's consent screen."""
    state = secrets.token_urlsafe(32)
    params = {
        "client_id": config.require("GOOGLE_CLIENT_ID"),
        "redirect_uri": redirect_uri(),
        "response_type": "code",
        "scope": SCOPES,
        "state": state,
        # Google only returns a refresh token on the first consent, and we
        # never use one — the session is ours, not Google's.
        "prompt": "select_account",
    }

    response = RedirectResponse(
        f"{AUTH_ENDPOINT}?{urllib.parse.urlencode(params)}", status_code=302
    )
    # The state is round-tripped through Google and compared on return, which
    # is what stops an attacker feeding you their own authorization code.
    response.set_cookie(
        STATE_COOKIE,
        state,
        max_age=_STATE_MAX_AGE,
        httponly=True,
        secure=_secure_cookies(),
        samesite="lax",
        path="/api/auth",
    )
    return response


@router.get("/google/callback")
def google_callback(
    request: Request,
    code: Optional[str] = None,
    state: Optional[str] = None,
    error: Optional[str] = None,
) -> RedirectResponse:
    """Google's return trip: verify state, exchange the code, start a session.

    Ends in a redirect to the app in every case, including failure. The user is
    sitting in a browser mid-navigation; a JSON error body would strand them on
    a blank page.
    """
    if error:
        logger.warning("Google returned an error: %s", error)
        return _finish("/?auth=denied")

    expected = request.cookies.get(STATE_COOKIE)
    # compare_digest rather than ==, so a mismatch can't be narrowed down by
    # timing. Both values must exist: a missing cookie is itself a failure.
    if not state or not expected or not secrets.compare_digest(state, expected):
        logger.warning("OAuth state mismatch")
        return _finish("/?auth=failed")

    if not code:
        return _finish("/?auth=failed")

    try:
        tokens = _post_form(
            TOKEN_ENDPOINT,
            {
                "code": code,
                "client_id": config.require("GOOGLE_CLIENT_ID"),
                "client_secret": config.require("GOOGLE_CLIENT_SECRET"),
                "redirect_uri": redirect_uri(),
                "grant_type": "authorization_code",
            },
        )
        profile = _get_json(USERINFO_ENDPOINT, tokens["access_token"])
    except urllib.error.HTTPError as exc:
        # The overwhelmingly likely cause is a redirect_uri that doesn't match
        # the console entry, so say so rather than leaving a bare 400.
        logger.error(
            "Google token exchange failed (%s). Check that %s is registered "
            "verbatim as an authorized redirect URI.",
            exc.code,
            redirect_uri(),
        )
        return _finish("/?auth=failed")
    except Exception:
        logger.exception("Google sign-in failed")
        return _finish("/?auth=failed")

    google_sub = profile.get("sub")
    if not google_sub:
        logger.error("Google profile had no subject id")
        return _finish("/?auth=failed")

    user = db.upsert_user(
        google_sub=google_sub,
        email=profile.get("email", ""),
        # Fall back to the local part of the email so a missing name never
        # renders as an empty byline.
        display_name=profile.get("name")
        or profile.get("email", "").split("@")[0]
        or "Panthers fan",
        avatar_url=profile.get("picture"),
    )

    if user["is_banned"]:
        logger.info("Banned user %s attempted to sign in", user["id"])
        return _finish("/?auth=banned")

    token = secrets.token_urlsafe(32)
    db.create_session(user["id"], token)

    response = _finish("/?auth=ok")
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=db.SESSION_TTL_DAYS * 24 * 60 * 60,
        httponly=True,  # unreadable from JS, so XSS can't lift the session
        secure=_secure_cookies(),
        # Lax is what makes this app CSRF-safe without tokens: it withholds the
        # cookie from cross-site POSTs while still sending it on the top-level
        # GET navigation that lands here.
        samesite="lax",
        path="/",
    )
    response.delete_cookie(STATE_COOKIE, path="/api/auth")
    return response


def _finish(path: str) -> RedirectResponse:
    return RedirectResponse(path, status_code=302)


@router.post("/logout")
def logout(panthers_session: Optional[str] = Cookie(default=None)) -> JSONResponse:
    """Revoke the session server-side, not just in the browser.

    Clearing the cookie alone would leave a working token in the database that
    anyone who captured it could keep using.
    """
    if panthers_session:
        try:
            db.delete_session(panthers_session)
        except Exception:
            logger.exception("Failed to delete session row")

    response = JSONResponse({"ok": True})
    response.delete_cookie(SESSION_COOKIE, path="/")
    return response


@router.get("/me", response_model=Optional[CurrentUser])
def me(user: Optional[CurrentUser] = Depends(current_user)) -> Optional[CurrentUser]:
    """The signed-in user, or null. Deliberately never 401s."""
    return user
