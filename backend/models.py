from datetime import datetime
from typing import Dict, List, Optional

from pydantic import BaseModel


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
