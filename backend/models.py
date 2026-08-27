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


# --- Live game ---------------------------------------------------------------
class LiveTeam(BaseModel):
    """One side of the game being followed."""

    id: str
    abbreviation: str
    name: str
    short_name: str
    logo: Optional[str] = None
    score: Optional[int] = None
    # "0-0" before anything is played; preseason records stay at 0-0 all August.
    record: Optional[str] = None
    # Points per quarter, in order. Empty until the first quarter ends; a
    # trailing None is a quarter still being played.
    linescores: List[Optional[int]] = []
    panthers: bool = False
    home: bool = False


class LiveSituation(BaseModel):
    """Where the ball is, right now. Only ever populated while a game is live."""

    # Whose ball it is, as an abbreviation, so the client doesn't match team ids.
    possession: Optional[str] = None
    # "2nd & 7 at CAR 45" and its short form "2nd & 7".
    down_distance: Optional[str] = None
    short_down_distance: Optional[str] = None
    # "CAR 45" — where the ball is spotted.
    spot: Optional[str] = None
    # Distance to the end zone the offense is attacking, for the field graphic.
    yards_to_endzone: Optional[int] = None
    last_play: Optional[str] = None
    red_zone: bool = False
    panthers_timeouts: Optional[int] = None
    opponent_timeouts: Optional[int] = None


class StatPair(BaseModel):
    """One team stat, both sides, ready to draw as a pair of bars.

    `*_display` is what a reader sees ("3-11", "31:58"); `*_value` is the number
    the bar length comes from. They differ often enough — a possession time is
    read as a clock and drawn as seconds — that keeping one field for both would
    force the client to reparse ESPN's formatting.
    """

    key: str
    label: str
    panthers_display: Optional[str] = None
    opponent_display: Optional[str] = None
    panthers_value: Optional[float] = None
    opponent_value: Optional[float] = None


class ScoringPlay(BaseModel):
    """One score, with the game score it produced."""

    id: str
    period: int
    clock: Optional[str] = None
    team_abbr: Optional[str] = None
    panthers: bool = False
    text: str
    # "TD" | "FG" | "SF" ...
    type_abbr: Optional[str] = None
    panthers_score: int = 0
    opponent_score: int = 0


class Drive(BaseModel):
    """One drive, with its field position normalized to Carolina's perspective.

    `start_yard` and `end_yard` are yards from Carolina's own goal line: 0 is
    Carolina's end zone, 100 is the opponent's. ESPN reports them from the home
    team's goal line instead, which flips meaning depending on who is hosting —
    doing that conversion here keeps one convention on the wire and lets the
    drive chart draw the field the same way every week.
    """

    id: str
    team_abbr: Optional[str] = None
    panthers: bool = False
    # "10 plays, 42 yards, 4:10"
    description: Optional[str] = None
    result: Optional[str] = None
    period: Optional[int] = None
    plays: Optional[int] = None
    yards: Optional[int] = None
    is_score: bool = False
    start_yard: Optional[int] = None
    end_yard: Optional[int] = None
    start_text: Optional[str] = None
    end_text: Optional[str] = None
    time_elapsed: Optional[str] = None


class WinProbPoint(BaseModel):
    """Carolina's win probability after one play.

    `elapsed` is seconds of game clock burned, so the chart has a real time axis
    rather than a play-index one — plays are not evenly spaced in time, and a
    17-play drive would otherwise stretch across the same width as a three-and-out.
    """

    elapsed: int
    period: int
    panthers_pct: float


class GameLeader(BaseModel):
    """One team's leader in one statistical category."""

    category: str
    category_label: str
    team_abbr: Optional[str] = None
    panthers: bool = False
    name: str
    jersey: Optional[str] = None
    position: Optional[str] = None
    headshot: Optional[str] = None
    # ESPN's own phrasing: "16/24, 121 YDS".
    display_value: Optional[str] = None


class LiveGame(BaseModel):
    """Everything the Live tab renders, for whichever game matters right now.

    Populated progressively: before kickoff only the matchup, venue, weather and
    line exist; the stats, drives and win probability arrive as the game is
    played. Every list therefore defaults to empty rather than being optional —
    a section with nothing in it is hidden, not an error.
    """

    event_id: str
    # 1 preseason, 2 regular season, 3 postseason — ESPN's numbering.
    season: int
    season_type: int
    season_label: Optional[str] = None
    week: Optional[int] = None
    name: Optional[str] = None
    short_name: Optional[str] = None

    # "pre" | "in" | "post"
    state: str = "pre"
    completed: bool = False
    # "Final", "8:00 PM EDT", "10:32 - 2nd"
    status_detail: Optional[str] = None
    period: Optional[int] = None
    clock: Optional[str] = None

    kickoff: Optional[datetime] = None
    venue: Optional[str] = None
    venue_city: Optional[str] = None
    venue_state: Optional[str] = None
    attendance: Optional[int] = None
    broadcast: Optional[str] = None
    # Only a scheduled game has a forecast worth showing.
    temperature: Optional[int] = None
    precipitation: Optional[int] = None
    # The line, phrased as the book prints it: "CAR -1.5".
    line: Optional[str] = None
    over_under: Optional[float] = None

    panthers: LiveTeam
    opponent: LiveTeam

    situation: Optional[LiveSituation] = None
    team_stats: List[StatPair] = []
    scoring_plays: List[ScoringPlay] = []
    drives: List[Drive] = []
    win_probability: List[WinProbPoint] = []
    leaders: List[GameLeader] = []

    # When this snapshot was taken, so the client can say how stale it is.
    fetched_at: Optional[datetime] = None


class Injury(BaseModel):
    """One line on the injury report.

    Everything below `status` is optional because ESPN fills the report in as
    the week goes on: a player can be listed Out on Wednesday with no body part
    named and no note attached until Friday.
    """

    id: str
    # ESPN's athlete id, which joins this line to `Player.id` on the roster.
    # `id` above is the id of the report entry, not of the player.
    athlete_id: Optional[str] = None
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
    # True when the season these numbers belong to is over.
    final: bool = False
    # True before Week 1, when every line has been zeroed back to 0-0. Callers
    # use it to drop the parts of the table that only mean something once games
    # have been played: rank, streak, opponent records.
    preseason: bool = False
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
    # ESPN's event id, set only on a game thread the app opened for itself.
    # Null on everything a person wrote, which is what the UI keys the badge on.
    event_id: Optional[str] = None
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
    # emoji -> the display names behind it, oldest first and capped by the
    # query. Only names: this is the hover on a reaction, and the same privacy
    # line PostAuthor draws applies to everyone who taps one.
    reactors: Dict[str, List[str]] = {}


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
    reactors: Dict[str, List[str]] = {}
