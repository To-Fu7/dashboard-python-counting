import os
import cv2
import json
import datetime
import uuid
import numpy as np
from ultralytics import YOLO
import psycopg2
import time
import logging
from collections import defaultdict
from zoneinfo import ZoneInfo
import base64
from dotenv import load_dotenv
import paho.mqtt.client as mqtt
import threading
import ast
import queue

from traffic_counting import TrafficCounter, load_line_pairs_from_env
from zone_detection import ZoneDetector, load_zones_from_env

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# ── Timezone & counters ───────────────────────────────────────────────────────
local_tz = ZoneInfo("Asia/Jakarta")
class_counts = defaultdict(int)

resample_record_id = None
resample_hour_in = 0
resample_hour_out = 0
current_tracking_hour = None
person_history = {}
is_midnight = False
record_id = ''
person_in = 0
person_out = 0
interval_person_in = 0
interval_person_out = 0
last_mqtt_send = None
last_daily_send = None
latest_person_coordinates = []

# ── Environment ───────────────────────────────────────────────────────────────
load_dotenv('.env')
PG_HOST = os.getenv('PG_HOST')
PG_PORT = int(os.getenv('PG_PORT', 5432))
PG_DB = os.getenv('PG_DB')
PG_USER = os.getenv('PG_USER')
PG_PASS = os.getenv('PG_PASS')
device_id = os.getenv('DEVICE_ID')
device_code = os.getenv('DEVICE_CODE')
device_name = os.getenv('DEVICE_NAME')

MQTT_BROKER = os.getenv('MQTT_BROKER', 'localhost')
MQTT_PORT = int(os.getenv('MQTT_PORT', '1883'))
MQTT_USERNAME = os.getenv('MQTT_USERNAME')
MQTT_PASSWORD = os.getenv('MQTT_PASSWORD')
MQTT_TOPIC = os.getenv('MQTT_TOPIC', '/xxx')
MQTT_INTERVAL_TOPIC = os.getenv('MQTT_INTERVAL_TOPIC', '/resampling_person/xxx')
MQTT_INTERVAL_MINUTES = int(os.getenv('MQTT_INTERVAL_MINUTES', 5))
DAILY_SEND_TIME = os.getenv('DAILY_SEND_TIME', '23:59')

RTSP_URL = os.getenv('RTSP_URL')
resolution = ast.literal_eval(os.getenv('SCREEN_RESOLUTION'))

ENABLE_NVDEC = os.getenv('ENABLE_NVDEC', 'false').lower() == 'true'
NVDEC_BACKEND = os.getenv('NVDEC_BACKEND', 'cuvid').lower()
USE_ONNX = os.getenv('USE_ONNX', 'true').lower() == 'true'

DETECTION_MODE = os.getenv('DETECTION_MODE', 'line_crossing').lower()
POINT_AXIS = os.getenv('POINT_AXIS', 'X')
DETECTION_STYLE = os.getenv('DETECTION_STYLE', 'dot').lower()
LINE_OFFSET = os.getenv('LINE_OFFSET', 'X')
LINE_OFFSET_AMOUNT = int(os.getenv('LINE_OFFSET_AMOUNT', 5))
DOT_OFFSET = os.getenv('DOT_OFFSET', 'Y')
DOT_OFFSET_AMOUNT = int(os.getenv('DOT_OFFSET_AMOUNT', 0))
SWAP_IN_OUT = os.getenv('SWAP_IN_OUT', 'false').lower() == 'true'
MERGE_GATES = os.getenv('MERGE_GATES', 'false').lower() == 'true'

_detection_margin_raw = os.getenv('DETECTION_MARGIN', '160').strip().lower()
GLOBAL_DETECTION = _detection_margin_raw in ('false', '0')
DETECTION_MARGIN = 0 if GLOBAL_DETECTION else int(_detection_margin_raw)

CROP_PADDING = 30
MIN_CROP_SIZE = (128, 128)
JPEG_QUALITY = int(os.getenv('JPEG_QUALITY', 70))

YOLO_MODEL = os.getenv('YOLO_MODEL', 'yolo11n.pt')
YOLO_CONFIDENCE = float(os.getenv('YOLO_CONFIDENCE', 0.3))
YOLO_DEVICE = os.getenv('YOLO_DEVICE', 'auto')
YOLO_IMGSZ = int(os.getenv('YOLO_IMGSZ', '640'))

# BBOX FILTER — reduces false positives (e.g. poles misclassified as person).
# PERSON_MIN_ASPECT_RATIO: min w/h ratio (poles ~0.05, people ~0.25-0.6). 0 = disabled.
PERSON_MIN_ASPECT_RATIO = float(os.getenv('PERSON_MIN_ASPECT_RATIO', '0.15'))
# PERSON_MIN_HEIGHT_PX: minimum bbox height in pixels. 0 = disabled.
PERSON_MIN_HEIGHT_PX = int(os.getenv('PERSON_MIN_HEIGHT_PX', '0'))

FPS_LIMIT = float(os.getenv('FPS_LIMIT', '0'))
FRAME_INTERVAL = 1.0 / FPS_LIMIT if FPS_LIMIT > 0 else 0
FRAME_SKIP = max(1, int(os.getenv('FRAME_SKIP', '2')))

DEBUG_MODE = os.getenv('DEBUG_MODE', 'true').lower() == 'true'

# ── Detector init ─────────────────────────────────────────────────────────────
if DETECTION_MODE == 'line_crossing':
    LINE_PAIRS = load_line_pairs_from_env()
    logging.info(f"Total line pairs loaded: {len(LINE_PAIRS)}")
    ZONES = []
elif DETECTION_MODE == 'zone':
    ZONES = load_zones_from_env()
    if not ZONES:
        raise RuntimeError("DETECTION_MODE=zone but no zone polygons defined. Define at least 'zoneA'.")
    LINE_PAIRS = []
else:
    LINE_PAIRS = []
    ZONES = []

logging.info(f"DETECTION_MODE = {DETECTION_MODE}")
logging.info(f"SWAP_IN_OUT = {SWAP_IN_OUT}")
logging.info(f"MERGE_GATES = {MERGE_GATES}")

# Detection crop region (line_crossing mode only)
if DETECTION_MODE == 'line_crossing' and LINE_PAIRS and not GLOBAL_DETECTION:
    all_y = [y for lp in LINE_PAIRS for (_, y) in lp['in_line'] + lp['out_line']]
    DETECTION_Y_MIN = max(0, min(all_y) - DETECTION_MARGIN)
    DETECTION_Y_MAX = max(all_y) + DETECTION_MARGIN
    logging.info(f"Detection region: Y {DETECTION_Y_MIN}–{DETECTION_Y_MAX} (margin {DETECTION_MARGIN}px)")
else:
    DETECTION_Y_MIN = 0
    DETECTION_Y_MAX = None
    logging.info("Detection region: GLOBAL (full frame)")

# ── MQTT ──────────────────────────────────────────────────────────────────────
mqtt_client = None

def init_mqtt():
    global mqtt_client
    try:
        mqtt_client = mqtt.Client()
        if MQTT_USERNAME and MQTT_PASSWORD:
            mqtt_client.username_pw_set(MQTT_USERNAME, MQTT_PASSWORD)
        mqtt_client.on_connect = lambda c, u, f, rc: (
            logging.info("Connected to MQTT broker") if rc == 0
            else logging.error(f"MQTT connect failed rc={rc}")
        )
        mqtt_client.on_disconnect = lambda c, u, rc: logging.warning("Disconnected from MQTT broker")
        mqtt_client.connect(MQTT_BROKER, MQTT_PORT, 60)
        mqtt_client.loop_start()
    except Exception as e:
        logging.error(f"Failed to initialize MQTT: {e}")
        mqtt_client = None


def send_person_in_mqtt(image, rec_id, event_type="person_in"):
    if DEBUG_MODE or mqtt_client is None:
        if DEBUG_MODE:
            logging.info(f"DEBUG_MODE: Skipping MQTT send for {event_type}")
        else:
            logging.warning("MQTT client not initialized, skipping message")
        return
    try:
        _, buf = cv2.imencode('.jpg', image, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
        payload = {
            "record_id": rec_id,
            "device_id": device_id,
            "device_code": device_code,
            "device_name": device_name,
            "timestamp": datetime.datetime.now(local_tz).isoformat(),
            "event": event_type,
            "image": base64.b64encode(buf.tobytes()).decode('utf-8'),
        }
        result = mqtt_client.publish(MQTT_TOPIC, json.dumps(payload), qos=1)
        if result.rc != mqtt.MQTT_ERR_SUCCESS:
            logging.error(f"Failed to send MQTT message, rc={result.rc}")
    except Exception as e:
        logging.error(f"Error sending MQTT message: {e}")


def send_interval_mqtt_data():
    global mqtt_client, last_mqtt_send, last_daily_send, interval_person_in, interval_person_out
    if DEBUG_MODE or mqtt_client is None:
        return

    current_time = datetime.datetime.now(local_tz)
    if last_mqtt_send is not None:
        elapsed = (current_time - last_mqtt_send).total_seconds()
        if elapsed < (MQTT_INTERVAL_MINUTES * 60) - 5:
            logging.warning(f"Skipping duplicate interval send ({elapsed:.0f}s since last)")
            return

    last_mqtt_send = current_time
    snap_in, snap_out = interval_person_in, interval_person_out
    interval_person_in = 0
    interval_person_out = 0

    try:
        payload = {
            "record_id": record_id,
            "device_id": device_id,
            "device_code": device_code,
            "device_name": device_name,
            "timestamp": current_time.isoformat(),
            "event": "interval_data",
            "data": {
                "interval_in": snap_in,
                "interval_out": snap_out,
                "total_in": person_in,
                "total_out": person_out,
                "net_count": person_in - person_out,
                "interval_net": snap_in - snap_out,
                "interval_minutes": MQTT_INTERVAL_MINUTES,
            },
        }
        result = mqtt_client.publish(MQTT_INTERVAL_TOPIC, json.dumps(payload), qos=1)
        if result.rc == mqtt.MQTT_ERR_SUCCESS:
            logging.info(f"Interval MQTT sent — IN:{snap_in} OUT:{snap_out} Total IN:{person_in} OUT:{person_out}")
            if resample_record_id is not None:
                db_queue_write(
                    "UPDATE inout_resample SET interval_in=%s, interval_out=%s, updated_at=now() WHERE id=%s",
                    (resample_hour_in, resample_hour_out, resample_record_id),
                )
        else:
            interval_person_in += snap_in
            interval_person_out += snap_out
            logging.error(f"Interval MQTT failed rc={result.rc}")
    except Exception as e:
        interval_person_in += snap_in
        interval_person_out += snap_out
        logging.error(f"Error sending interval MQTT: {e}")


def should_send_interval_mqtt():
    global last_mqtt_send, last_daily_send
    now = datetime.datetime.now(local_tz)
    dh, dm = map(int, DAILY_SEND_TIME.split(':'))
    if now.hour == dh and now.minute == dm and now.second < 10:
        if last_daily_send is None or last_daily_send.date() != now.date():
            last_daily_send = now
            logging.info("Daily MQTT send triggered")
            return True
    if last_mqtt_send is None:
        return True
    return (now - last_mqtt_send).total_seconds() >= MQTT_INTERVAL_MINUTES * 60


# ── Database ──────────────────────────────────────────────────────────────────
pg_conn = None
cursor = None
db_queue = queue.Queue()
db_thread_running = True


def db_connect():
    return psycopg2.connect(dbname=PG_DB, user=PG_USER, password=PG_PASS, host=PG_HOST, port=PG_PORT)


def db_get_cursor():
    try:
        conn = db_connect()
        return conn, conn.cursor()
    except Exception as e:
        logging.error(f"Postgres connection failed: {e}")
        return None, None


def db_query(sql, params=(), commit=False, max_retry=3):
    global pg_conn, cursor
    if DEBUG_MODE:
        logging.info(f"DEBUG_MODE: Skipping DB query: {sql}")
        return True
    for retry in range(max_retry):
        try:
            cursor.execute(sql, params)
            if commit:
                pg_conn.commit()
            return True
        except (psycopg2.OperationalError, psycopg2.InterfaceError) as e:
            logging.error(f"DB lost connection: {e} (retry {retry+1}/{max_retry})")
            try:
                cursor.close(); pg_conn.close()
            except Exception:
                pass
            pg_conn, cursor = db_get_cursor()
            if not cursor:
                time.sleep(2)
        except Exception as e:
            logging.error(f"DB error: {e}")
            try:
                pg_conn.rollback()
            except Exception:
                pass
            time.sleep(2)
    logging.error("DB operation failed after max retries.")
    return False


def db_fetch(sql, params=(), commit=False, max_retry=3):
    global pg_conn, cursor
    if DEBUG_MODE:
        logging.info(f"DEBUG_MODE: Skipping DB fetch: {sql}")
        return None
    for retry in range(max_retry):
        try:
            cursor.execute(sql, params)
            if commit:
                pg_conn.commit()
            return cursor.fetchone()
        except (psycopg2.OperationalError, psycopg2.InterfaceError) as e:
            logging.error(f"DB lost connection: {e} (retry {retry+1}/{max_retry})")
            try:
                cursor.close(); pg_conn.close()
            except Exception:
                pass
            pg_conn, cursor = db_get_cursor()
            if not cursor:
                time.sleep(2)
        except Exception as e:
            logging.error(f"DB error: {e}")
            try:
                pg_conn.rollback()
            except Exception:
                pass
            time.sleep(2)
    logging.error("DB fetch failed after max retries.")
    return None


def db_queue_write(query, params):
    if DEBUG_MODE:
        logging.info(f"DEBUG_MODE: Skipping async DB write: {query}")
        return
    db_queue.put((query, params))


def db_worker():
    global db_thread_running
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


if not DEBUG_MODE:
    pg_conn, cursor = db_get_cursor()
    if not cursor:
        logging.error("Fatal: DB connection failed at startup")
        exit(1)
    logging.info("Connected to PostgreSQL")
else:
    pg_conn, cursor = None, None

logging.info(f"RESOLUTION = {resolution}")

# ── Counts & DB records ───────────────────────────────────────────────────────
def should_reset():
    now = datetime.datetime.now(local_tz)
    return now.hour == 0 and now.minute == 0 and now.second < 10


def get_latest_counts(dev_id):
    row = db_fetch(
        "SELECT id, total_in, total_out, data, created_at FROM person_inout "
        "WHERE device_id=%s ORDER BY created_at DESC LIMIT 1",
        (dev_id,),
    )
    if not row:
        return None, None, None, None
    last_id, total_in, total_out, data, created_utc = row
    counts = {'in': total_in or 0, 'out': total_out or 0}
    extra = None
    if data:
        try:
            extra = data if isinstance(data, dict) else json.loads(data)
        except Exception:
            pass
    last_date = created_utc.astimezone(local_tz).date()
    today = datetime.datetime.now(local_tz).date()
    return (counts, last_date, {'id': last_id}, extra) if last_date == today else (None, last_date, {'id': last_id}, extra)


def init_resample_record():
    global resample_record_id, resample_hour_in, resample_hour_out, current_tracking_hour
    now = datetime.datetime.now(local_tz)
    hour_slot = now.replace(minute=0, second=0, microsecond=0)
    current_tracking_hour = hour_slot
    result = db_fetch(
        """
        INSERT INTO inout_resample (device_id, device_name, device_code, interval_in, interval_out, hour_start)
        VALUES (%s, %s, %s, 0, 0, %s)
        ON CONFLICT (device_id, hour_start) DO UPDATE
            SET device_name=EXCLUDED.device_name, device_code=EXCLUDED.device_code
        RETURNING id, interval_in, interval_out
        """,
        (device_id, device_name, device_code, hour_slot),
        commit=True,
    )
    if result:
        resample_record_id, resample_hour_in, resample_hour_out = result
        logging.info(f"Resample record for {hour_slot}: IN={resample_hour_in} OUT={resample_hour_out}")
    else:
        logging.error(f"Failed to upsert resample record for {hour_slot}")


def handle_hour_change():
    global resample_hour_in, resample_hour_out
    send_interval_mqtt_data()
    resample_hour_in = 0
    resample_hour_out = 0
    init_resample_record()


def initialize_counts():
    global person_in, person_out, record_id, class_counts, interval_person_in, interval_person_out
    interval_person_in = 0
    interval_person_out = 0
    if DEBUG_MODE:
        new_id = str(uuid.uuid4())
        record_id = new_id
        class_counts['in'] = 0
        class_counts['out'] = 0
        person_in = 0
        person_out = 0
        logging.info(f"DEBUG_MODE: initialized with record {new_id}")
        return {'id': new_id}
    restored, last_date, last_id, _ = get_latest_counts(device_id)
    if restored:
        class_counts.update(restored)
        person_in = class_counts['in']
        person_out = class_counts['out']
        record_id = last_id['id']
        logging.info(f"Restored counts ({last_date}): IN={person_in} OUT={person_out}")
        init_resample_record()
        return last_id
    new_id = str(uuid.uuid4())
    if db_query("INSERT INTO person_inout (id, device_id, total_in, total_out) VALUES (%s,%s,%s,%s)",
                (new_id, device_id, 0, 0), commit=True):
        record_id = new_id
        class_counts['in'] = 0
        class_counts['out'] = 0
        person_in = 0
        person_out = 0
        logging.info(f"New record created: {new_id}")
        init_resample_record()
        return {'id': new_id}
    logging.error("Failed to create new DB record")
    return None


def reset_counts(detector):
    global class_counts, person_history, record_id, person_in, person_out
    global last_mqtt_send, last_daily_send, interval_person_in, interval_person_out
    global resample_hour_in, resample_hour_out

    send_interval_mqtt_data()
    person_in = person_out = 0
    interval_person_in = interval_person_out = 0
    resample_hour_in = resample_hour_out = 0
    class_counts.clear()
    class_counts['in'] = 0
    class_counts['out'] = 0
    person_history.clear()
    detector.reset()

    new_id = str(uuid.uuid4())
    if DEBUG_MODE:
        record_id = new_id
        last_mqtt_send = None
        logging.info("== Midnight reset (DEBUG_MODE) ==")
    else:
        if db_query("INSERT INTO person_inout (id, device_id, total_in, total_out) VALUES (%s,%s,%s,%s)",
                    (new_id, device_id, 0, 0), commit=True):
            record_id = new_id
            last_mqtt_send = None
            logging.info("== Midnight reset ==")
        else:
            logging.error("Failed to create new record at midnight")
    init_resample_record()


# ── Video / model helpers ─────────────────────────────────────────────────────
def crop_image(frame, box, padding=None):
    if padding is None:
        padding = CROP_PADDING
    x1, y1, x2, y2 = box
    h, w = frame.shape[:2]
    x1c, y1c = max(0, x1 - padding), max(0, y1 - padding)
    x2c, y2c = min(w, x2 + padding), min(h, y2 + padding)
    crop = frame[y1c:y2c, x1c:x2c]
    ch, cw = crop.shape[:2]
    if ch < MIN_CROP_SIZE[1] or cw < MIN_CROP_SIZE[0]:
        ar = cw / ch if ch > 0 else 1
        new_h = max(MIN_CROP_SIZE[1], ch)
        new_w = int(new_h * ar)
        if new_w < MIN_CROP_SIZE[0]:
            new_w = MIN_CROP_SIZE[0]
            new_h = int(new_w / ar)
        crop = cv2.resize(crop, (new_w, new_h), interpolation=cv2.INTER_LANCZOS4)
    return crop


def is_valid_person_box(x1, y1, x2, y2, track_id=None):
    """Filter false positives (e.g. poles) by bounding box shape."""
    w, h = x2 - x1, y2 - y1
    if h <= 0:
        return False
    if PERSON_MIN_HEIGHT_PX > 0 and h < PERSON_MIN_HEIGHT_PX:
        logging.debug(f"[bbox-filter] track {track_id} rejected: h={h}px < {PERSON_MIN_HEIGHT_PX}px")
        return False
    if PERSON_MIN_ASPECT_RATIO > 0 and (w / h) < PERSON_MIN_ASPECT_RATIO:
        logging.debug(f"[bbox-filter] track {track_id} rejected: w/h={w/h:.2f} < {PERSON_MIN_ASPECT_RATIO}")
        return False
    return True


def resolve_yolo_device(device_str):
    if device_str.lower() == 'auto':
        import torch
        if torch.cuda.is_available():
            logging.info(f"YOLO_DEVICE=auto: CUDA → GPU 0 ({torch.cuda.get_device_name(0)})")
            return '0'
        logging.info("YOLO_DEVICE=auto: no CUDA, using CPU")
        return 'cpu'
    logging.info(f"YOLO_DEVICE={device_str}")
    return device_str


def get_or_create_onnx(pt_path, imgsz=640):
    base = os.path.splitext(pt_path)[0]
    onnx_path = f"{base}_imgsz{imgsz}.onnx"
    if os.path.exists(onnx_path):
        logging.info(f"[ONNX] Cache hit: {onnx_path}")
        return onnx_path
    logging.info(f"[ONNX] Exporting {pt_path} → {onnx_path} (~30s)...")
    try:
        from ultralytics import YOLO as _YOLO
        _YOLO(pt_path).export(format='onnx', imgsz=imgsz, half=False, simplify=True, verbose=False, dynamic=True)
    except Exception as e:
        logging.error(f"[ONNX] Export failed: {e}. Falling back to .pt")
        return pt_path
    default_onnx = base + '.onnx'
    if os.path.exists(default_onnx) and default_onnx != onnx_path:
        os.rename(default_onnx, onnx_path)
    if not os.path.exists(onnx_path):
        logging.error("[ONNX] File not found after export. Falling back to .pt")
        return pt_path
    logging.info(f"[ONNX] Ready: {onnx_path}")
    return onnx_path


def _build_gstreamer_nvdec_pipeline(source):
    if source.startswith('rtsp://'):
        return (
            f"rtspsrc location={source} latency=200 protocols=tcp ! "
            "rtph264depay ! h264parse ! nvv4l2decoder ! "
            "nvvidconv ! video/x-raw,format=BGRx ! videoconvert ! "
            "video/x-raw,format=BGR ! appsink drop=1 max-buffers=1 sync=false"
        )
    return None


def initialize_video_capture(video_source):
    logging.info(f"Initializing video capture: {video_source}")
    if ENABLE_NVDEC and NVDEC_BACKEND == 'gstreamer':
        pipeline = _build_gstreamer_nvdec_pipeline(video_source)
        if pipeline:
            logging.info("NVDEC: GStreamer nvv4l2decoder (Jetson)")
            return cv2.VideoCapture(pipeline, cv2.CAP_GSTREAMER)
    elif ENABLE_NVDEC:
        os.environ['OPENCV_FFMPEG_CAPTURE_OPTIONS'] = 'hwaccel;cuda|video_codec;h264_cuvid|rtsp_transport;tcp'
        logging.info("NVDEC: h264_cuvid (x86)")
    cap = cv2.VideoCapture(video_source, cv2.CAP_FFMPEG)
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    cap.set(cv2.CAP_PROP_FPS, 10)
    return cap


def validate_cctv_connection(rtsp_url):
    if not rtsp_url or not rtsp_url.strip():
        return False
    try:
        cap = cv2.VideoCapture(rtsp_url, cv2.CAP_FFMPEG)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        if not cap.isOpened():
            cap.release()
            return False
        ret, frame = cap.read()
        cap.release()
        return ret and frame is not None
    except Exception:
        return False


def get_video_source():
    fallback = '1.mp4'
    if not RTSP_URL or not RTSP_URL.strip():
        logging.warning(f"RTSP_URL not set, falling back to {fallback}")
        return fallback
    if validate_cctv_connection(RTSP_URL):
        logging.info("Using CCTV stream")
        return RTSP_URL
    logging.warning(f"CCTV connection failed, falling back to {fallback}")
    if os.path.exists(fallback):
        return fallback
    raise FileNotFoundError(f"Neither CCTV stream nor {fallback} available")


def safe_destroy_windows():
    try:
        cv2.destroyAllWindows()
    except cv2.error:
        pass


def RGB(event, x, y, flags, param):
    if event == cv2.EVENT_MOUSEMOVE:
        print([x, y])


# ── Main loop ─────────────────────────────────────────────────────────────────
def main():
    global person_in, person_out, is_midnight, record_id, latest_person_coordinates
    global interval_person_in, interval_person_out, db_thread_running
    global resample_hour_in, resample_hour_out

    if not DEBUG_MODE:
        threading.Thread(target=db_worker, daemon=True).start()
        logging.info("DB worker thread started")

    init_mqtt()

    last_data_id = initialize_counts()
    if not last_data_id and not DEBUG_MODE:
        logging.error("Failed to initialize database")
        return

    logging.info(f"MQTT interval: {MQTT_INTERVAL_MINUTES}min | Daily send: {DAILY_SEND_TIME}")
    logging.info(f"Crop: padding={CROP_PADDING}px size={MIN_CROP_SIZE} quality={JPEG_QUALITY}%")
    logging.info(f"BBox filter: min_aspect={PERSON_MIN_ASPECT_RATIO} min_height={PERSON_MIN_HEIGHT_PX}px")

    try:
        video_source = get_video_source()
    except FileNotFoundError as e:
        logging.error(f"Fatal: {e}")
        return

    resolved_device = resolve_yolo_device(YOLO_DEVICE)

    if USE_ONNX and resolved_device != 'cpu' and YOLO_MODEL.endswith('.pt'):
        model_path = get_or_create_onnx(YOLO_MODEL, imgsz=YOLO_IMGSZ)
    else:
        model_path = YOLO_MODEL

    try:
        model = YOLO(model_path)
    except Exception as e:
        if model_path.endswith('.onnx'):
            logging.error(f"[ONNX] Load failed: {e}. Retrying with .pt")
            os.remove(model_path)
            model = YOLO(YOLO_MODEL)
            model_path = YOLO_MODEL
        else:
            raise

    logging.info(f"Model loaded: {model_path}")

    # Instantiate the appropriate detector
    if DETECTION_MODE == 'line_crossing':
        detector = TrafficCounter(LINE_PAIRS, {
            'detection_style': DETECTION_STYLE,
            'point_axis': POINT_AXIS,
            'swap_in_out': SWAP_IN_OUT,
            'merge_gates': MERGE_GATES,
            'dot_offset_amount': DOT_OFFSET_AMOUNT,
            'debug_mode': DEBUG_MODE,
        })
    else:
        detector = ZoneDetector(ZONES)

    last_waiting_log = time.time()

    while True:
        try:
            logging.info('Initializing service...')
            cap = initialize_video_capture(video_source)
            if not cap.isOpened():
                raise Exception(f"Failed to open video source: {video_source}")
            logging.info(f"Video source opened: {video_source} | IN={person_in} OUT={person_out}")

            if DEBUG_MODE:
                cv2.namedWindow('RGB')
                cv2.setMouseCallback('RGB', RGB)

            count = 0
            last_process_time = time.time()
            fps_counter = 0
            fps_timer = time.time()

            while True:
                count += 1
                if count % FRAME_SKIP != 0:
                    cap.grab()
                    continue

                ret, frame = cap.read()

                if FRAME_INTERVAL > 0:
                    elapsed = time.time() - last_process_time
                    if elapsed < FRAME_INTERVAL:
                        time.sleep(FRAME_INTERVAL - elapsed)
                    last_process_time = time.time()

                if not ret:
                    raise Exception(f"Frame read error: {video_source}")

                frame = cv2.resize(frame, (resolution[0], resolution[1]))

                detection_frame = frame if GLOBAL_DETECTION else frame[DETECTION_Y_MIN:DETECTION_Y_MAX, :]

                results = model.track(
                    detection_frame, persist=True, verbose=False,
                    conf=YOLO_CONFIDENCE, device=resolved_device,
                    classes=[0], iou=0.3, imgsz=YOLO_IMGSZ, half=True,
                    tracker="bytetrack.yaml",
                )

                # Debug overlays (lines/zones)
                if DEBUG_MODE:
                    detector.draw_overlay(frame)
                    if DETECTION_MODE == 'line_crossing' and not GLOBAL_DETECTION:
                        cv2.line(frame, (0, DETECTION_Y_MIN), (1920, DETECTION_Y_MIN), (0, 255, 0), 2)
                        cv2.line(frame, (0, DETECTION_Y_MAX), (1920, DETECTION_Y_MAX), (0, 222, 0), 2)
                        cv2.putText(frame, 'Detection Region', (10, DETECTION_Y_MIN - 10),
                                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)

                original_frame = frame.copy() if (DEBUG_MODE or DETECTION_MODE == 'zone') else frame

                person_detected = False
                region_detections = 0
                latest_person_coordinates = []

                if results[0].boxes is not None and results[0].boxes.id is not None:
                    boxes = results[0].boxes.xyxy.int().cpu().tolist()
                    class_ids = results[0].boxes.cls.int().cpu().tolist()
                    track_ids = results[0].boxes.id.int().cpu().tolist()
                    confidences = results[0].boxes.conf.cpu().tolist()

                    for box, class_id, track_id, conf in zip(boxes, class_ids, track_ids, confidences):
                        if 'person' not in model.names[class_id]:
                            continue

                        x1, y1, x2, y2 = box
                        y1 += DETECTION_Y_MIN
                        y2 += DETECTION_Y_MIN

                        if not is_valid_person_box(x1, y1, x2, y2, track_id):
                            continue

                        person_detected = True
                        region_detections += 1

                        latest_person_coordinates.append({
                            "track_id": track_id,
                            "x": int(x1), "y": int(y1),
                            "w": int(x2 - x1), "h": int(y2 - y1),
                            "confidence": float(conf),
                            "center_x": int((x1 + x2) // 2),
                            "center_y": int((y1 + y2) // 2),
                        })

                        if DEBUG_MODE:
                            detector.draw_person(frame, x1, y1, x2, y2, track_id)

                        # Run detector
                        if DETECTION_MODE == 'line_crossing':
                            events = detector.process(x1, y1, x2, y2, track_id)
                        else:
                            events = detector.process(x1, y1, x2, y2, track_id, original_frame)

                        # Handle events
                        for ev in events:
                            if ev['type'] == 'person_in':
                                person_in += 1
                                interval_person_in += 1
                                resample_hour_in += 1
                                class_counts['in'] = person_in
                                db_queue_write(
                                    "UPDATE person_inout SET total_in=%s WHERE id=%s",
                                    (person_in, record_id),
                                )
                                send_person_in_mqtt(original_frame, record_id, "person_in")
                                logging.info(f"Person {ev['track_id']} IN ({ev['gate']}) — total IN:{person_in}")

                            elif ev['type'] == 'person_out':
                                person_out += 1
                                interval_person_out += 1
                                resample_hour_out += 1
                                class_counts['out'] = person_out
                                db_queue_write(
                                    "UPDATE person_inout SET total_out=%s WHERE id=%s",
                                    (person_out, record_id),
                                )
                                send_person_in_mqtt(original_frame, record_id, "person_out")
                                logging.info(f"Person {ev['track_id']} OUT ({ev['gate']}) — total OUT:{person_out}")

                            elif ev['type'] == 'zone_entry':
                                person_in += 1
                                interval_person_in += 1
                                resample_hour_in += 1
                                class_counts['in'] = person_in
                                db_queue_write(
                                    "UPDATE person_inout SET total_in=%s WHERE id=%s",
                                    (person_in, record_id),
                                )
                                send_person_in_mqtt(ev['frame'], record_id, "zone_entry")
                                logging.info(f"Person {ev['track_id']} entered {ev['zone']} — total IN:{person_in}")

                if should_send_interval_mqtt():
                    send_interval_mqtt_data()

                if not person_detected:
                    now = time.time()
                    if now - last_waiting_log >= 60:
                        logging.info("Waiting for person detection...")
                        last_waiting_log = now

                if DEBUG_MODE:
                    cv2.putText(frame, f'IN: {person_in}', (50, 50), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 255, 0), 2)
                    cv2.putText(frame, f'OUT: {person_out}', (50, 100), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 255), 2)
                    cv2.putText(frame, f'Detections: {region_detections}', (50, 150), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 0), 2)
                    cv2.imshow('RGB', frame)
                    if cv2.waitKey(1) & 0xFF == ord('q'):
                        logging.info("User exit")
                        return

                fps_counter += 1
                if time.time() - fps_timer >= 10.0:
                    logging.info(f"Processing FPS: {fps_counter / (time.time() - fps_timer):.1f}")
                    fps_counter = 0
                    fps_timer = time.time()

                if not should_reset() and current_tracking_hour is not None:
                    now_hour = datetime.datetime.now(local_tz).replace(minute=0, second=0, microsecond=0)
                    if now_hour != current_tracking_hour:
                        handle_hour_change()

                if should_reset() and not is_midnight:
                    reset_counts(detector)
                    is_midnight = True

                if not should_reset() and is_midnight:
                    is_midnight = False

        except Exception as error:
            logging.error(f"Error: {error}. Restarting in 5s...")
            if 'cap' in locals():
                cap.release()
            safe_destroy_windows()
            time.sleep(5)

    if 'cap' in locals():
        cap.release()
    safe_destroy_windows()
    if mqtt_client:
        mqtt_client.loop_stop()
        mqtt_client.disconnect()


if __name__ == '__main__':
    main()
