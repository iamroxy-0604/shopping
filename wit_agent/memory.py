"""Persistent, session-scoped structured memory."""

import json
import sqlite3
from pathlib import Path


class MemoryManager:
    def __init__(self, path: str | Path):
        self.path = str(path)
        Path(self.path).parent.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            db.execute("CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, data TEXT NOT NULL)")

    def _connect(self):
        return sqlite3.connect(self.path, timeout=10)

    def load(self, session_id: str) -> dict:
        with self._connect() as db:
            row = db.execute("SELECT data FROM sessions WHERE id=?", (session_id,)).fetchone()
        return json.loads(row[0]) if row else {
            "preferences": {}, "current_items": [], "last_query": "", "turns": 0,
            "emotion": {}, "feedback": [],
        }

    def save(self, session_id: str, data: dict) -> None:
        with self._connect() as db:
            db.execute(
                "INSERT INTO sessions(id,data) VALUES(?,?) "
                "ON CONFLICT(id) DO UPDATE SET data=excluded.data",
                (session_id, json.dumps(data, ensure_ascii=False)),
            )

    def forget(self, session_id: str, field: str | None = None) -> dict:
        data = self.load(session_id)
        if field:
            data["preferences"].pop(field, None)
        else:
            data["preferences"] = {}
            data["feedback"] = []
            data["current_items"] = []
            data["last_query"] = ""
        self.save(session_id, data)
        return data
