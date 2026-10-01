"""SQLite memory: durable user preferences, isolated current-session products."""

import json
import sqlite3
from pathlib import Path


def _session_default() -> dict:
    return {"current_items": [], "last_query": "", "turns": 0, "emotion": {}, "temporary": {}}


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

    def _connect(self):
        return sqlite3.connect(self.path, timeout=10)

    def load(self, session_id: str, user_id: str | None = None) -> dict:
        user_id = user_id or session_id
        legacy_data = None
        with self._connect() as db:
            user_row = db.execute("SELECT data FROM users WHERE id=?", (user_id,)).fetchone()
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
        user = json.loads(user_row[0]) if user_row else {}
        session = json.loads(session_row[0]) if session_row else _session_default()
        return {
            **_session_default(), **session,
            "preferences": user.get("preferences", {}),
            "feedback": user.get("feedback", []),
        }

    def save(self, session_id: str, data: dict, user_id: str | None = None, *, forget_all: bool = False) -> None:
        user_id = user_id or session_id
        user = {"preferences": data.get("preferences", {}), "feedback": data.get("feedback", [])}
        session = {key: data.get(key, default) for key, default in _session_default().items()}
        with self._connect() as db:
            if forget_all:
                db.execute("DELETE FROM users WHERE id=?", (user_id,))
                db.execute("DELETE FROM chat_sessions WHERE user_id=?", (user_id,))
            db.execute(
                "INSERT INTO users(id,data) VALUES(?,?) "
                "ON CONFLICT(id) DO UPDATE SET data=excluded.data",
                (user_id, json.dumps(user, ensure_ascii=False)),
            )
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

    def forget(self, session_id: str, field: str | None = None, user_id: str | None = None) -> dict:
        data = self.load(session_id, user_id)
        if field and field != "all":
            data["preferences"].pop(field, None)
            data["temporary"].pop(field, None)
        else:
            data["preferences"] = {}
            data["temporary"] = {}
            data["feedback"] = []
            data["current_items"] = []
            data["last_query"] = ""
        self.save(session_id, data, user_id, forget_all=field is None or field == "all")
        return data
