"""Banco SQLite: artigos coletados, grupos (clusters) e resumos diários."""
import os
import sqlite3
from contextlib import contextmanager

SCHEMA = """
CREATE TABLE IF NOT EXISTS articles (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    url         TEXT UNIQUE NOT NULL,
    title       TEXT NOT NULL,
    snippet     TEXT DEFAULT '',
    source_id   TEXT NOT NULL,
    source_name TEXT NOT NULL,
    section     TEXT DEFAULT 'geral',
    published   TEXT NOT NULL,          -- ISO 8601 UTC
    day         TEXT NOT NULL,          -- YYYY-MM-DD (fuso de São Paulo)
    cluster_id  INTEGER,
    collected   TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_articles_day ON articles(day);

CREATE TABLE IF NOT EXISTS clusters (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    day          TEXT NOT NULL,
    headline     TEXT NOT NULL,
    summary      TEXT DEFAULT '',
    tema         TEXT DEFAULT 'Outros',
    tom          TEXT DEFAULT 'neutro',  -- neutro | tenso | positivo
    n_articles   INTEGER DEFAULT 0,
    n_sources    INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_clusters_day ON clusters(day);

CREATE TABLE IF NOT EXISTS daily (
    day      TEXT PRIMARY KEY,
    summary  TEXT NOT NULL,
    topics   TEXT NOT NULL              -- JSON: [{tema, n_clusters, n_articles, tom}]
);
"""


def db_path() -> str:
    return os.environ.get("RADAR_DB", "data/radar.db")


@contextmanager
def connect():
    path = db_path()
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()
