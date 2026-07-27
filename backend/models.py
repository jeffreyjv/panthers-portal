from datetime import datetime
from typing import Dict, List, Optional

from pydantic import BaseModel, Field, field_validator


class Article(BaseModel):
    """Normalized article shape shared by every source."""

    id: str
    title: str
    summary: str
    url: str
    published_at: Optional[datetime] = None
    image_url: Optional[str] = None
    source: str
    # Where the body text is fetched from, when that differs from `url`.
    # ESPN bot-blocks its article pages but serves the same story as JSON.
    content_url: Optional[str] = None


class ArticleContent(BaseModel):
    """Body text of one article, extracted from its source page.

    Plain text only — paragraphs carry no markup, so the client can render
    them directly without sanitizing.
    """

    id: str
    url: str
    paragraphs: List[str]


class Player(BaseModel):
    """One player on the roster."""

    id: str
    name: str
    # Kept as text: jersey numbers can be "00".
    jersey: Optional[str] = None
    position: Optional[str] = None
    position_name: Optional[str] = None
    # "Offense", "Defense", "Special Teams", "Injured Reserve", ...
    group: str
    height: Optional[str] = None
    weight: Optional[int] = None
    age: Optional[int] = None
    experience: Optional[int] = None
    college: Optional[str] = None
    headshot: Optional[str] = None
    # Set from the depth chart: first at their slot.
    starter: bool = False
    # The slot they start at, e.g. "LDE" — more specific than `position`.
    depth_position: Optional[str] = None


class Game(BaseModel):
    """One entry on the season calendar: a game, or a bye week.

    Bye weeks carry only `week` and `bye=True`; every opponent field is None.
    """

    week: int
    bye: bool = False
    # ESPN's event id, which the odds endpoints are keyed on. None for byes.
    event_id: Optional[str] = None
    kickoff: Optional[datetime] = None
    opponent: Optional[str] = None
    opponent_abbr: Optional[str] = None
    opponent_logo: Optional[str] = None
    home: Optional[bool] = None
    venue: Optional[str] = None
    network: Optional[str] = None
    # "scheduled" | "in_progress" | "final"
    status: str = "scheduled"
    team_score: Optional[int] = None
    opponent_score: Optional[int] = None
    # "W" | "L" | "T", set only once the game is final.
    outcome: Optional[str] = None
    url: Optional[str] = None


class GameLine(BaseModel):
    """The betting line on one game, from a single sportsbook.

    Every number is oriented to Carolina: a `spread` of "+2.5" means the
    Panthers are getting points. The book's own `details` string ("CHI -2.5")
    is kept verbatim, since that is the phrasing a bettor recognizes.
    """

    week: int
    provider: str
    details: Optional[str] = None
    over_under: Optional[float] = None
    # Signed from Carolina's side: "-3.5" when favoured, "+2.5" when not.
    spread: Optional[str] = None
    # American odds. Kept as ints so the sign survives; the client formats them.
    money_line: Optional[int] = None
    opponent_money_line: Optional[int] = None
    favorite: bool = False


class SeasonFutures(BaseModel):
    """Carolina's futures prices, as the American odds strings books quote."""

    provider: str
    division: Optional[str] = None
    conference: Optional[str] = None
    super_bowl: Optional[str] = None


class Odds(BaseModel):
    """Every price the schedule shows, in one payload.

    The two halves are fetched independently: futures thin out as a season runs
    on, and a book may not have posted a game months away. Either one missing
    leaves the other rendering.
    """

    season: int
    futures: Optional[SeasonFutures] = None
    # Keyed by week. Only games a book has actually priced appear, so a row
    # with no entry renders exactly as it did before odds existed.
    lines: Dict[int, GameLine] = {}


class Injury(BaseModel):
    """One line on the injury report.

    Everything below `status` is optional because ESPN fills the report in as
    the week goes on: a player can be listed Out on Wednesday with no body part
    named and no note attached until Friday.
    """

    id: str
    name: str
    position: Optional[str] = None
    headshot: Optional[str] = None
    # "Out" | "Doubtful" | "Questionable" | "Injured Reserve" | ...
    status: str
    # The body part, as ESPN words it: "Knee", "Hamstring", "Undisclosed".
    body_part: Optional[str] = None
    # What happened to it: "Soreness", "Sprain". None when unspecified — ESPN
    # sends the string "Not Specified", which is not worth a line on screen.
    detail: Optional[str] = None
    return_date: Optional[datetime] = None
    # ESPN's one-line beat-reporter note on the latest update.
    comment: Optional[str] = None
    updated_at: Optional[datetime] = None
    url: Optional[str] = None


class TeamStanding(BaseModel):
    """One team's line in the standings."""

    team_id: str
    name: str
    abbreviation: str
    logo: Optional[str] = None
    wins: int = 0
    losses: int = 0
    ties: int = 0
    # Pre-formatted "8-9" / "8-9-1", so callers don't reassemble it.
    record: str = "0-0"
    win_pct: Optional[str] = None
    # "W1", "L2" — as ESPN words it.
    streak: Optional[str] = None
    points_for: Optional[int] = None
    points_against: Optional[int] = None
    division_record: Optional[str] = None
    playoff_seed: Optional[int] = None
    # ESPN's clinch marker: "z" division, "x" playoffs, "e" eliminated, ...
    clinched: Optional[str] = None
    panthers: bool = False


class Standings(BaseModel):
    """A division table plus every team's record.

    `division` is the NFC South in standings order, which is what the strip
    renders. `league` covers all 32 teams keyed by abbreviation so schedule
    rows can show an opponent's record without a second request.
    """

    season: int
    # True when the season is over, or hasn't kicked off yet and these are the
    # previous season's final numbers.
    final: bool = False
    division: List[TeamStanding] = []
    league: Dict[str, TeamStanding] = {}


# --- Talk --------------------------------------------------------------------
# The reactions a post can carry. Enforced server-side: without an allowlist,
# `emoji` is an unbounded user-controlled string going straight into the
# database and onto everyone else's screen.
ALLOWED_REACTIONS = ("🔥", "😭", "👏", "🐾")

MAX_POST_LENGTH = 500


class CurrentUser(BaseModel):
    """The signed-in viewer, as the frontend sees themselves.

    `email` is included because it is the viewer's own; it never appears on
    anyone else's post, where `PostAuthor` is used instead.
    """

    id: int
    display_name: str
    avatar_url: Optional[str] = None
    email: str


class PostAuthor(BaseModel):
    """Who wrote a post, as shown to everyone.

    Deliberately no email — publishing the address of everyone who ever posted
    would be the easiest privacy mistake in the app to make.
    """

    id: int
    display_name: str
    avatar_url: Optional[str] = None


class Post(BaseModel):
    """One post or reply.

    `body` is null exactly when `deleted` is true: a removed post survives only
    to hold its replies together, and its text is not served again.
    """

    id: int
    parent_id: Optional[int] = None
    author: PostAuthor
    body: Optional[str] = None
    created_at: datetime
    edited_at: Optional[datetime] = None
    deleted: bool = False
    reply_count: int = 0
    # emoji -> count, covering everyone.
    reactions: Dict[str, int] = {}
    # Which of those the viewer picked, so the UI can light them up. Always
    # empty when signed out.
    viewer_reactions: List[str] = []


class Feed(BaseModel):
    """A page of top-level posts, newest first.

    `next_cursor` is opaque to the client: it hands the value back to ask for
    the following page, and nothing else.
    """

    posts: List[Post]
    next_cursor: Optional[str] = None


class PostCreate(BaseModel):
    body: str = Field(min_length=1, max_length=MAX_POST_LENGTH)

    @field_validator("body")
    @classmethod
    def not_only_whitespace(cls, value: str) -> str:
        """Trim, and reject anything that was only spaces.

        min_length alone passes a body of twenty blank lines, which renders as
        an empty card nobody can tell apart from a bug.
        """
        trimmed = value.strip()
        if not trimmed:
            raise ValueError("Post cannot be empty")
        return trimmed


class ReactionCreate(BaseModel):
    emoji: str

    @field_validator("emoji")
    @classmethod
    def known_emoji(cls, value: str) -> str:
        if value not in ALLOWED_REACTIONS:
            raise ValueError(f"Unsupported reaction. Pick one of: {' '.join(ALLOWED_REACTIONS)}")
        return value


class ReactionResult(BaseModel):
    """The post's reaction state after a toggle, so the client can reconcile
    its optimistic update against what actually landed."""

    post_id: int
    reactions: Dict[str, int] = {}
    viewer_reactions: List[str] = []
