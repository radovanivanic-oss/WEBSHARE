# -*- coding: utf-8 -*-

from __future__ import absolute_import, division, unicode_literals

import json
import os
import sqlite3
import time

from resources.lib.paths import profile_path


DB_PATH = profile_path("catalog_index.db")


class AtlasStore(object):
    def __init__(self):
        self.db_path = DB_PATH
        self._ensure_schema()

    def connect(self):
        conn = sqlite3.connect(self.db_path)
        conn.row_factory = sqlite3.Row
        return conn

    def _ensure_schema(self):
        parent = os.path.dirname(self.db_path)
        if not os.path.exists(parent):
            os.makedirs(parent)
        with sqlite3.connect(self.db_path) as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS items (
                  ident TEXT PRIMARY KEY,
                  title TEXT,
                  catalog_title TEXT,
                  name TEXT,
                  size INTEGER,
                  extension TEXT,
                  mime TEXT,
                  media_type TEXT,
                  year INTEGER,
                  quality TEXT,
                  language TEXT,
                  audio_type TEXT,
                  subtitle_type TEXT,
                  genre TEXT,
                  series_title TEXT,
                  season INTEGER,
                  episode INTEGER,
                  source TEXT,
                  url TEXT,
                  added_order INTEGER,
                  search_text TEXT
                );

                CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT);
                CREATE TABLE IF NOT EXISTS favorites (
                  ident TEXT PRIMARY KEY,
                  created_at INTEGER
                );
                CREATE TABLE IF NOT EXISTS playback (
                  ident TEXT PRIMARY KEY,
                  position REAL DEFAULT 0,
                  duration REAL DEFAULT 0,
                  percent REAL DEFAULT 0,
                  play_count INTEGER DEFAULT 0,
                  watched INTEGER DEFAULT 0,
                  updated_at INTEGER
                );
                CREATE TABLE IF NOT EXISTS searches (
                  query TEXT PRIMARY KEY,
                  updated_at INTEGER
                );
                CREATE TABLE IF NOT EXISTS pins (
                  kind TEXT,
                  item_key TEXT,
                  label TEXT,
                  payload TEXT,
                  created_at INTEGER,
                  PRIMARY KEY(kind, item_key)
                );
                CREATE TABLE IF NOT EXISTS saved_filters (
                  name TEXT PRIMARY KEY,
                  payload TEXT,
                  created_at INTEGER,
                  updated_at INTEGER
                );
                CREATE TABLE IF NOT EXISTS hidden_home (
                  item_key TEXT PRIMARY KEY,
                  created_at INTEGER
                );
                CREATE TABLE IF NOT EXISTS metadata_cache (
                  cache_key TEXT PRIMARY KEY,
                  payload TEXT,
                  updated_at INTEGER
                );
                """
            )
            self._ensure_item_columns(conn)
            conn.executescript(
                """
                CREATE INDEX IF NOT EXISTS idx_items_media ON items(media_type);
                CREATE INDEX IF NOT EXISTS idx_items_quality ON items(quality);
                CREATE INDEX IF NOT EXISTS idx_items_language ON items(language);
                CREATE INDEX IF NOT EXISTS idx_items_audio ON items(audio_type);
                CREATE INDEX IF NOT EXISTS idx_items_subtitles ON items(subtitle_type);
                CREATE INDEX IF NOT EXISTS idx_items_genre ON items(genre);
                CREATE INDEX IF NOT EXISTS idx_items_year ON items(year);
                CREATE INDEX IF NOT EXISTS idx_items_series ON items(series_title, season, episode);
                CREATE INDEX IF NOT EXISTS idx_items_added ON items(added_order);
                """
            )

    def _ensure_item_columns(self, conn):
        columns = set(
            row[1] for row in conn.execute("PRAGMA table_info(items)").fetchall()
        )
        migrations = {
            "audio_type": "ALTER TABLE items ADD COLUMN audio_type TEXT DEFAULT 'unknown'",
            "subtitle_type": "ALTER TABLE items ADD COLUMN subtitle_type TEXT DEFAULT 'unknown'",
            "genre": "ALTER TABLE items ADD COLUMN genre TEXT DEFAULT 'unknown'",
            "catalog_title": "ALTER TABLE items ADD COLUMN catalog_title TEXT DEFAULT ''",
        }
        for column, sql in migrations.items():
            if column not in columns:
                conn.execute(sql)

    def replace_items(self, rows, state):
        with self.connect() as conn:
            conn.execute("DELETE FROM items")
            conn.executemany(
                """
                INSERT OR REPLACE INTO items (
                  ident, title, catalog_title, name, size, extension, mime, media_type, year,
                  quality, language, audio_type, subtitle_type, genre,
                  series_title, season, episode, source, url,
                  added_order, search_text
                ) VALUES (
                  :ident, :title, :catalog_title, :name, :size, :extension, :mime, :media_type, :year,
                  :quality, :language, :audio_type, :subtitle_type, :genre,
                  :series_title, :season, :episode, :source, :url,
                  :added_order, :search_text
                )
                """,
                rows,
            )
            for key, value in state.items():
                conn.execute(
                    "INSERT OR REPLACE INTO state(key, value) VALUES(?, ?)",
                    (key, json.dumps(value)),
                )

    def state_value(self, key, default=None):
        with self.connect() as conn:
            row = conn.execute("SELECT value FROM state WHERE key = ?", (key,)).fetchone()
        if not row:
            return default
        try:
            return json.loads(row["value"])
        except Exception:
            return default

    def catalog_state(self):
        state = self.state_value("catalog", {})
        with self.connect() as conn:
            counts = conn.execute(
                """
                SELECT
                  COUNT(*) AS total,
                  SUM(CASE WHEN media_type = 'movie' THEN 1 ELSE 0 END) AS movies,
                  SUM(CASE WHEN media_type = 'episode' THEN 1 ELSE 0 END) AS episodes
                FROM items
                """
            ).fetchone()
        state["item_count"] = counts["total"] or 0
        state["movie_count"] = counts["movies"] or 0
        state["episode_count"] = counts["episodes"] or 0
        state["unknown_count"] = state["item_count"] - state["movie_count"] - state["episode_count"]
        return state

    def item_count(self):
        with self.connect() as conn:
            row = conn.execute("SELECT COUNT(*) AS count FROM items").fetchone()
        return row["count"] if row else 0

    def get_item(self, ident):
        with self.connect() as conn:
            return conn.execute("SELECT * FROM items WHERE ident = ?", (ident,)).fetchone()

    def _item_where(self, params):
        where = []
        values = []

        if params.get("q"):
            words = [word.lower() for word in params["q"].split() if word.strip()]
            for word in words:
                where.append("search_text LIKE ?")
                values.append("%{}%".format(word))

        for key in (
            "media_type",
            "quality",
            "language",
            "audio_type",
            "subtitle_type",
            "genre",
            "series_title",
            "extension",
            "source",
        ):
            if params.get(key):
                where.append("{} = ?".format(key))
                values.append(params[key])

        if params.get("catalog_title"):
            where.append("catalog_title = ?")
            values.append(params["catalog_title"])

        if params.get("season"):
            where.append("season = ?")
            values.append(int(params["season"]))

        if params.get("year_from") is not None and params.get("year_to") is not None:
            start = int(params.get("year_from") or 0)
            end = int(params.get("year_to") or 0)
            if start == 0 and end == 0:
                where.append("(year IS NULL OR year = 0)")
            else:
                where.append("year BETWEEN ? AND ?")
                values.extend([start, end])

        if params.get("year"):
            where.append("year = ?")
            values.append(int(params["year"]))

        if params.get("size_min"):
            where.append("size >= ?")
            values.append(int(params["size_min"]))

        if params.get("size_max"):
            where.append("size <= ?")
            values.append(int(params["size_max"]))

        return where, values

    def query_items(self, params, limit=50, offset=0):
        where, values = self._item_where(params)
        order = "added_order ASC"
        preset = params.get("preset")

        if preset == "large":
            order = "size DESC"
        elif preset == "small":
            order = "size ASC"
        elif preset == "random":
            order = "RANDOM()"
        elif preset == "recent":
            order = "added_order ASC"
        elif preset == "title":
            order = "title COLLATE NOCASE ASC"
        elif preset == "episode":
            order = "season ASC, episode ASC, added_order ASC"

        sql = "SELECT * FROM items"
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY {} LIMIT ? OFFSET ?".format(order)
        values.extend([limit + 1, offset])

        with self.connect() as conn:
            rows = conn.execute(sql, values).fetchall()
        return rows[:limit], len(rows) > limit

    def movie_groups(self, params, limit=50, offset=0):
        group_params = dict(params)
        group_params["media_type"] = "movie"
        where, values = self._item_where(group_params)
        where.append("COALESCE(NULLIF(catalog_title, ''), title, name) != ''")

        order = "latest_order ASC"
        preset = params.get("preset")
        if preset == "title":
            order = "group_title COLLATE NOCASE ASC"
        elif preset == "random":
            order = "RANDOM()"
        elif preset == "year":
            order = "year DESC, group_title COLLATE NOCASE ASC"

        sql = """
            SELECT
              COALESCE(NULLIF(catalog_title, ''), title, name) AS group_title,
              COALESCE(year, 0) AS year,
              COUNT(*) AS stream_count,
              MIN(added_order) AS latest_order,
              MAX(size) AS max_size,
              group_concat(DISTINCT quality) AS qualities,
              group_concat(DISTINCT language) AS languages
            FROM items
        """
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += """
            GROUP BY group_title, COALESCE(year, 0)
            ORDER BY {}
            LIMIT ? OFFSET ?
        """.format(order)
        values.extend([limit + 1, offset])

        with self.connect() as conn:
            groups = conn.execute(sql, values).fetchall()

        return groups[:limit], len(groups) > limit

    def movie_group_items(self, title, year=0, limit=100):
        where = ["media_type = 'movie'", "catalog_title = ?"]
        values = [title]
        if int(year or 0) > 0:
            where.append("year = ?")
            values.append(int(year))
        else:
            where.append("(year IS NULL OR year = 0)")
        values.append(limit)
        with self.connect() as conn:
            return conn.execute(
                """
                SELECT *
                FROM items
                WHERE {}
                ORDER BY
                  CASE quality
                    WHEN '2160p' THEN 1
                    WHEN '1080p' THEN 2
                    WHEN '720p' THEN 3
                    WHEN 'SD' THEN 4
                    ELSE 5
                  END,
                  size DESC
                LIMIT ?
                """.format(" AND ".join(where)),
                values,
            ).fetchall()

    def series_titles(self, limit=50, offset=0, preset="recent"):
        order = "latest_order ASC"
        if preset == "title":
            order = "series_title COLLATE NOCASE ASC"

        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT series_title, COUNT(*) AS count, MIN(added_order) AS latest_order
                FROM items
                WHERE media_type = 'episode' AND series_title IS NOT NULL AND series_title != ''
                GROUP BY series_title
                ORDER BY {}
                LIMIT ? OFFSET ?
                """.format(order),
                (limit + 1, offset),
            ).fetchall()
        return rows[:limit], len(rows) > limit

    def series_seasons(self, series_title):
        with self.connect() as conn:
            return conn.execute(
                """
                SELECT season, COUNT(*) AS count, MIN(added_order) AS latest_order
                FROM items
                WHERE series_title = ?
                GROUP BY season
                ORDER BY latest_order ASC, season DESC
                """,
                (series_title,),
            ).fetchall()

    def add_search(self, query):
        with self.connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO searches(query, updated_at) VALUES(?, ?)",
                (query, int(time.time())),
            )

    def recent_searches(self, limit=25):
        with self.connect() as conn:
            return conn.execute(
                "SELECT query, updated_at FROM searches ORDER BY updated_at DESC LIMIT ?",
                (limit,),
            ).fetchall()

    def add_favorite(self, ident):
        if not ident:
            return
        with self.connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO favorites(ident, created_at) VALUES(?, ?)",
                (ident, int(time.time())),
            )

    def remove_favorite(self, ident):
        with self.connect() as conn:
            conn.execute("DELETE FROM favorites WHERE ident = ?", (ident,))

    def favorite_items(self, media_type=None, limit=50):
        where = []
        values = []
        if media_type:
            where.append("items.media_type = ?")
            values.append(media_type)
        values.append(limit + 1)
        sql = """
            SELECT items.*
            FROM favorites
            JOIN items ON items.ident = favorites.ident
        """
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY favorites.created_at DESC LIMIT ?"
        with self.connect() as conn:
            rows = conn.execute(sql, values).fetchall()
        return rows[:limit], len(rows) > limit

    def record_play_start(self, ident):
        if not ident:
            return
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO playback(ident, position, duration, percent, play_count, watched, updated_at)
                VALUES(?, 0, 0, 0, 1, 0, ?)
                ON CONFLICT(ident) DO UPDATE SET
                  play_count = playback.play_count + 1,
                  updated_at = excluded.updated_at
                """,
                (ident, int(time.time())),
            )
        self.write_now_playing(ident)

    def write_now_playing(self, ident):
        row = self.get_item(ident)
        data = {"ident": ident, "title": row["title"] if row else ident}
        with open(profile_path("now_playing.json"), "w", encoding="utf-8") as handle:
            json.dump(data, handle)

    def update_resume(self, ident, position, duration):
        if not ident:
            return
        percent = 0
        if duration:
            percent = max(0, min(100, position * 100 / duration))
        watched = 1 if percent >= 90 else 0
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO playback(ident, position, duration, percent, play_count, watched, updated_at)
                VALUES(?, ?, ?, ?, 1, ?, ?)
                ON CONFLICT(ident) DO UPDATE SET
                  position = excluded.position,
                  duration = excluded.duration,
                  percent = excluded.percent,
                  watched = excluded.watched,
                  updated_at = excluded.updated_at
                """,
                (ident, position, duration, percent, watched, int(time.time())),
            )

    def mark_watched(self, ident):
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO playback(ident, position, duration, percent, play_count, watched, updated_at)
                VALUES(?, 0, 0, 100, 1, 1, ?)
                ON CONFLICT(ident) DO UPDATE SET
                  percent = 100,
                  watched = 1,
                  updated_at = excluded.updated_at
                """,
                (ident, int(time.time())),
            )

    def resume_items(self, media_type=None, limit=50):
        where = "playback.watched = 0 AND playback.percent > 0 AND playback.percent < 90"
        values = []
        if media_type:
            where += " AND items.media_type = ?"
            values.append(media_type)
        values.append(limit + 1)
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT items.*
                FROM playback
                JOIN items ON items.ident = playback.ident
                WHERE {}
                ORDER BY playback.updated_at DESC
                LIMIT ?
                """.format(where),
                values,
            ).fetchall()
        return rows[:limit], len(rows) > limit

    def history_items(self, watched=None, limit=50):
        where = []
        values = []
        if watched is not None:
            where.append("playback.watched = ?")
            values.append(int(watched))
        values.append(limit + 1)
        sql = """
            SELECT items.*
            FROM playback
            JOIN items ON items.ident = playback.ident
        """
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY playback.updated_at DESC LIMIT ?"
        with self.connect() as conn:
            rows = conn.execute(sql, values).fetchall()
        return rows[:limit], len(rows) > limit

    def clear_index(self):
        with self.connect() as conn:
            conn.execute("DELETE FROM items")
            conn.execute("DELETE FROM state WHERE key = 'catalog'")

    def clear_history(self):
        with self.connect() as conn:
            conn.execute("DELETE FROM playback")

    def add_pin(self, kind, item_key, label, payload):
        with self.connect() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO pins(kind, item_key, label, payload, created_at)
                VALUES(?, ?, ?, ?, ?)
                """,
                (kind, item_key, label, json.dumps(payload), int(time.time())),
            )

    def remove_pin(self, kind, item_key):
        with self.connect() as conn:
            conn.execute(
                "DELETE FROM pins WHERE kind = ? AND item_key = ?",
                (kind, item_key),
            )

    def pinned_items(self, kind=None, limit=25):
        values = []
        sql = "SELECT kind, item_key, label, payload FROM pins"
        if kind:
            sql += " WHERE kind = ?"
            values.append(kind)
        sql += " ORDER BY created_at DESC LIMIT ?"
        values.append(limit)
        with self.connect() as conn:
            return conn.execute(sql, values).fetchall()

    def hide_home_item(self, item_key):
        with self.connect() as conn:
            conn.execute(
                "INSERT OR REPLACE INTO hidden_home(item_key, created_at) VALUES(?, ?)",
                (item_key, int(time.time())),
            )

    def reset_hidden_home(self):
        with self.connect() as conn:
            conn.execute("DELETE FROM hidden_home")

    def hidden_home_keys(self):
        with self.connect() as conn:
            rows = conn.execute("SELECT item_key FROM hidden_home").fetchall()
        return set([row["item_key"] for row in rows])

    def save_filter(self, name, payload):
        now = int(time.time())
        with self.connect() as conn:
            conn.execute(
                """
                INSERT INTO saved_filters(name, payload, created_at, updated_at)
                VALUES(?, ?, ?, ?)
                ON CONFLICT(name) DO UPDATE SET
                  payload = excluded.payload,
                  updated_at = excluded.updated_at
                """,
                (name, json.dumps(payload), now, now),
            )

    def delete_filter(self, name):
        with self.connect() as conn:
            conn.execute("DELETE FROM saved_filters WHERE name = ?", (name,))

    def saved_filters(self, limit=50):
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT name, payload, updated_at
                FROM saved_filters
                ORDER BY updated_at DESC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
        return rows

    def metadata_get_many(self, cache_keys, ttl_seconds):
        cache_keys = list(cache_keys)
        if not cache_keys:
            return {}
        placeholders = ",".join("?" for _ in cache_keys)
        min_updated = int(time.time()) - int(ttl_seconds)
        with self.connect() as conn:
            rows = conn.execute(
                """
                SELECT cache_key, payload
                FROM metadata_cache
                WHERE updated_at >= ? AND cache_key IN ({})
                """.format(placeholders),
                [min_updated] + list(cache_keys),
            ).fetchall()
        result = {}
        for row in rows:
            try:
                result[row["cache_key"]] = json.loads(row["payload"])
            except Exception:
                pass
        return result

    def metadata_set(self, cache_key, payload):
        with self.connect() as conn:
            conn.execute(
                """
                INSERT OR REPLACE INTO metadata_cache(cache_key, payload, updated_at)
                VALUES(?, ?, ?)
                """,
                (cache_key, json.dumps(payload), int(time.time())),
            )

    def clear_metadata_cache(self):
        with self.connect() as conn:
            conn.execute("DELETE FROM metadata_cache")
