"""One-stop database provisioning: creates person_inout, inout_resample, and
detection_events if they don't already exist. Safe to run repeatedly.

Usage:  python init_db.py
Reads the same PG_* environment variables as main.py (via a .env file or the
process environment).
"""
import logging
import os

import psycopg2
from dotenv import load_dotenv

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

load_dotenv('.env')

PG_HOST = os.getenv('PG_HOST')
PG_PORT = int(os.getenv('PG_PORT', 5432))
PG_DB = os.getenv('PG_DB')
PG_USER = os.getenv('PG_USER')
PG_PASS = os.getenv('PG_PASS')

SCHEMA_STATEMENTS = [
    """
    CREATE TABLE IF NOT EXISTS person_inout (
        id UUID PRIMARY KEY,
        device_id UUID NOT NULL,
        total_in INTEGER NOT NULL DEFAULT 0,
        total_out INTEGER NOT NULL DEFAULT 0,
        data JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_person_inout_device_time ON person_inout (device_id, created_at DESC)",
    """
    CREATE TABLE IF NOT EXISTS inout_resample (
        id SERIAL PRIMARY KEY,
        device_id UUID NOT NULL,
        device_name TEXT,
        device_code TEXT,
        interval_in INTEGER NOT NULL DEFAULT 0,
        interval_out INTEGER NOT NULL DEFAULT 0,
        hour_start TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (device_id, hour_start)
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS detection_events (
        id UUID PRIMARY KEY,
        device_id UUID NOT NULL,
        device_code TEXT NOT NULL,
        device_name TEXT,
        detection_type TEXT NOT NULL,
        tag TEXT NOT NULL CHECK (tag IN ('info', 'alarm')),
        label TEXT NOT NULL,
        track_id INTEGER,
        confidence REAL NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_detection_events_device_time ON detection_events (device_id, created_at DESC)",
]


def main():
    logging.info(f"Connecting to {PG_HOST}:{PG_PORT}/{PG_DB} as {PG_USER}...")
    conn = psycopg2.connect(dbname=PG_DB, user=PG_USER, password=PG_PASS, host=PG_HOST, port=PG_PORT)
    conn.autocommit = True
    try:
        with conn.cursor() as cur:
            for stmt in SCHEMA_STATEMENTS:
                cur.execute(stmt)
                logging.info(f"OK: {stmt.strip().splitlines()[0].strip()}")
        logging.info("Schema is up to date (person_inout, inout_resample, detection_events).")
    finally:
        conn.close()


if __name__ == '__main__':
    main()
