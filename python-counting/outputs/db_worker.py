"""PostgreSQL layer — connection, retrying query/fetch, and the async write
worker thread. Extracted verbatim from legacy main.py (db_* functions).
"""
import logging
import queue
import threading
import time

import psycopg2

import counting_config as cfg

pg_conn, cursor = None, None

# Async database write queue for non-blocking DB operations
db_queue = queue.Queue()
db_thread_running = True
_db_worker_thread = None


def db_connect():
    """Create database connection"""
    return psycopg2.connect(
        dbname=cfg.PG_DB,
        user=cfg.PG_USER,
        password=cfg.PG_PASS,
        host=cfg.PG_HOST,
        port=cfg.PG_PORT
    )


def db_get_cursor():
    """Get database connection and cursor"""
    try:
        connect = db_connect()
        return connect, connect.cursor()
    except Exception as error:
        logging.error(f"Postgres Connection Failed: {error}")
        return None, None


def init_db():
    """Connect at startup (skipped in DEBUG_MODE). Returns True on success."""
    global pg_conn, cursor
    if cfg.DEBUG_MODE:
        return True
    pg_conn, cursor = db_get_cursor()
    if not cursor:
        logging.error("Fatal: Error on Connecting DB at Start Up")
        return False
    logging.info("Successfully connected to PostgreSQL database")
    return True


def db_worker():
    """Background worker thread for async database writes"""
    while db_thread_running:
        try:
            item = db_queue.get(timeout=1)
            if item is None:
                break
            query, params = item
            db_query(query, params, commit=True)
            db_queue.task_done()
        except queue.Empty:
            continue
        except Exception as e:
            logging.error(f"DB worker error: {e}")


def start_db_worker():
    global _db_worker_thread
    if cfg.DEBUG_MODE:
        return
    _db_worker_thread = threading.Thread(target=db_worker, daemon=True)
    _db_worker_thread.start()
    logging.info("Async database worker thread started")


def db_queue_write(query, params):
    """Queue a database write operation for async execution"""
    if cfg.DEBUG_MODE:
        logging.info(f"DEBUG_MODE: Skipping async DB write: {query}")
        return
    db_queue.put((query, params))


def db_query(sql, params=(), commit=False, max_retry=3):
    """Execute database query with retry logic"""
    global pg_conn, cursor

    if cfg.DEBUG_MODE:
        logging.info(f"DEBUG_MODE: Skipping DB query: {sql}")
        return True

    retry = 0
    while retry < max_retry:
        try:
            cursor.execute(sql, params)
            if commit:
                pg_conn.commit()
            return True
        except (psycopg2.OperationalError, psycopg2.InterfaceError) as error:
            logging.error(f"Database lost connection: {error} (retry {retry+1}/{max_retry})")
            try:
                cursor.close()
                pg_conn.close()
            except Exception:
                pass
            pg_conn, cursor = db_get_cursor()
            if not cursor:
                logging.error("DB Reconnection failed.")
                time.sleep(2)
                retry += 1
                continue
        except Exception as error:
            logging.error(f"DB Error (not connection): {error}")
            try:
                pg_conn.rollback()
            except Exception:
                pass
            time.sleep(2)
            retry += 1
            continue

    logging.error("DB operation failed after max retries.")
    return False


def db_fetch(sql, params=(), commit=False, max_retry=3):
    """Fetch data from database with retry logic"""
    global pg_conn, cursor

    if cfg.DEBUG_MODE:
        logging.info(f"DEBUG_MODE: Skipping DB fetch: {sql}")
        return None

    retry = 0
    while retry < max_retry:
        try:
            cursor.execute(sql, params)
            if commit:
                pg_conn.commit()
            return cursor.fetchone()
        except (psycopg2.OperationalError, psycopg2.InterfaceError) as e:
            logging.error(f"Database lost connection: {e} (retry {retry+1}/{max_retry})")
            try:
                cursor.close()
                pg_conn.close()
            except Exception:
                pass
            pg_conn, cursor = db_get_cursor()
            if not cursor:
                logging.error("Reconnection to DB failed.")
                time.sleep(2)
                retry += 1
                continue
        except Exception as e:
            logging.error(f"DB Error (not connection): {e}")
            try:
                pg_conn.rollback()
            except Exception:
                pass
            time.sleep(2)
            retry += 1
            continue

    logging.error("DB fetch failed after max retries.")
    return None
