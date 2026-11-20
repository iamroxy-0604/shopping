"""SQLite memory for independent shopping conversations."""

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path


def _session_default() -> dict:
    return {"current_items": [], "last_query": "", "turns": 0, "emotion": {}, "temporary": {},
            "questionnaire": None, "shopping_category": "", "shopping_answers": [],
            "pending_result": None, "preferences": {}, "feedback": [],
            "yuemai_anchor": None, "yuemai_initial_preferences": {},
            "shopping_requirement": None, "requirement_schema_version": 1,
            "asked_fields": [], "last_search_plan": None}


class MemoryManager:
    def __init__(self, path: str | Path):
        self.path = str(path)
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, data TEXT NOT NULL)")
            db.execute(
                "CREATE TABLE IF NOT EXISTS chat_sessions ("
                "user_id TEXT NOT NULL, session_id TEXT NOT NULL, data TEXT NOT NULL, "
                "PRIMARY KEY(user_id, session_id))"
            )
            db.execute(
                "CREATE TABLE IF NOT EXISTS category_exclusions ("
                "category_key TEXT PRIMARY KEY, exclude_terms_json TEXT NOT NULL, "
                "created_at TEXT NOT NULL, updated_at TEXT NOT NULL)"
            )

    def _connect(self):
        return sqlite3.connect(self.path, timeout=10)

    def load(self, session_id: str, user_id: str | None = None) -> dict:
        user_id = user_id or session_id
        legacy_data = None
        with self._connect() as db:
            session_row = db.execute(
                "SELECT data FROM chat_sessions WHERE user_id=? AND session_id=?",
                (user_id, session_id),
            ).fetchone()
            # Older sidecars stored preferences inside the session. Migrate only
            # the compatibility identity, never an explicit cross-session userId.
            if not session_row and user_id == session_id:
                table = db.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'"
                ).fetchone()
                legacy = db.execute("SELECT data FROM sessions WHERE id=?", (session_id,)).fetchone() if table else None
                if legacy:
                    legacy_data = json.loads(legacy[0])
        if legacy_data is not None:
            self.save(session_id, legacy_data, user_id)
            with self._connect() as db:
                db.execute("DELETE FROM sessions WHERE id=?", (session_id,))
            return self.load(session_id, user_id)
        session = json.loads(session_row[0]) if session_row else _session_default()
        if session_row and "preferences" not in session:
            # Before preferences became session-scoped, the session retained only
            # its own category. Recover that category without borrowing user data.
            category = session.get("shopping_category") or (session.get("questionnaire") or {}).get("category")
            session["preferences"] = {"category": category} if category else {}
        return {
            **_session_default(), **session,
        }

    def save(self, session_id: str, data: dict, user_id: str | None = None, *, forget_all: bool = False) -> None:
        user_id = user_id or session_id
        session = {key: data.get(key, default) for key, default in _session_default().items()}
        with self._connect() as db:
            if forget_all:
                db.execute("DELETE FROM users WHERE id=?", (user_id,))
                db.execute("DELETE FROM chat_sessions WHERE user_id=?", (user_id,))
            db.execute(
                "INSERT INTO chat_sessions(user_id,session_id,data) VALUES(?,?,?) "
                "ON CONFLICT(user_id,session_id) DO UPDATE SET data=excluded.data",
                (user_id, session_id, json.dumps(session, ensure_ascii=False)),
            )

    def reset_session(self, session_id: str, user_id: str | None = None) -> None:
        with self._connect() as db:
            db.execute(
                "DELETE FROM chat_sessions WHERE user_id=? AND session_id=?",
                (user_id or session_id, session_id),
            )

    def get_category_exclusions(self, category_key: str) -> list[str] | None:
        """Return shared category rules without exposing session/user memory."""
        key = str(category_key or "").strip()
        if not key:
            return None
        with self._connect() as db:
            row = db.execute(
                "SELECT exclude_terms_json FROM category_exclusions WHERE category_key=?",
                (key,),
            ).fetchone()
        if not row:
            return None
        try:
            terms = json.loads(row[0])
        except (TypeError, json.JSONDecodeError):
            return None
        return [term for term in terms if isinstance(term, str)] if isinstance(terms, list) else None

    def save_category_exclusions(self, category_key: str, exclude_terms: list[str]) -> None:
        """Upsert the only piece of memory shared across shoppers and sessions."""
        key = str(category_key or "").strip()
        if not key or not isinstance(exclude_terms, list) or not exclude_terms:
            return
        now = datetime.now(timezone.utc).isoformat()
        payload = json.dumps(exclude_terms, ensure_ascii=False, separators=(",", ":"))
        with self._connect() as db:
            db.execute(
                "INSERT INTO category_exclusions(category_key,exclude_terms_json,created_at,updated_at) "
                "VALUES(?,?,?,?) ON CONFLICT(category_key) DO UPDATE SET "
                "exclude_terms_json=excluded.exclude_terms_json,updated_at=excluded.updated_at",
                (key, payload, now, now),
            )

    def forget(self, session_id: str, field: str | None = None, user_id: str | None = None) -> dict:
        data = self.load(session_id, user_id)
        if field and field != "all":
            data["preferences"].pop(field, None)
            data["temporary"].pop(field, None)
            if field in ("category", "maxPrice"):
                data["shopping_requirement"] = None
                data["asked_fields"] = []
                data["last_search_plan"] = None
        else:
            data["preferences"] = {}
            data["temporary"] = {}
            data["feedback"] = []
            data["current_items"] = []
            data["last_query"] = ""
            data["yuemai_anchor"] = None
            data["yuemai_initial_preferences"] = {}
            data["shopping_requirement"] = None
            data["asked_fields"] = []
            data["last_search_plan"] = None
        self.save(session_id, data, user_id, forget_all=field is None or field == "all")
        return data
