from datetime import datetime
from typing import List, Optional

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
