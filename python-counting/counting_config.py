"""Environment configuration — extracted verbatim from legacy main.py.

New in the Triton migration:
    TRITON_URL    gRPC endpoint of the shared inference server (default triton:8001)
    TRITON_MODEL  model repository name (e.g. yolo26m_640). If unset, derived
                  from the legacy YOLO_MODEL value: yolo26m.pt -> yolo26m_640.

Deprecated (warned, ignored):
    YOLO_IMGSZ     input size now comes from Triton model metadata
    ENABLE_NVDEC   the slim client image has no CUDA/cuvid — software decode only
    YOLO_DEVICE    inference device is Triton's concern now
"""
import ast
import logging
import os
import string

import numpy as np
from dotenv import load_dotenv
from zoneinfo import ZoneInfo

logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

local_tz = ZoneInfo("Asia/Jakarta")

load_dotenv('.env')
PG_HOST = os.getenv('PG_HOST')
PG_PORT = int(os.getenv('PG_PORT', 5432))
PG_DB = os.getenv('PG_DB')
PG_USER = os.getenv('PG_USER')
PG_PASS = os.getenv('PG_PASS')
device_id = os.getenv('DEVICE_ID')
device_code = os.getenv('DEVICE_CODE')
device_name = os.getenv('DEVICE_NAME')

# MQTT Configuration
MQTT_BROKER = os.getenv('MQTT_BROKER', 'localhost')
MQTT_PORT = int(os.getenv('MQTT_PORT', '1883'))
MQTT_USERNAME = os.getenv('MQTT_USERNAME')
MQTT_PASSWORD = os.getenv('MQTT_PASSWORD')
MQTT_TOPIC = os.getenv('MQTT_TOPIC', '/xxx')  # example /person_in
MQTT_INTERVAL_TOPIC = os.getenv('MQTT_INTERVAL_TOPIC', '/resampling_person/xxx')

# Interval settings
MQTT_INTERVAL_MINUTES = int(os.getenv('MQTT_INTERVAL_MINUTES', 5))
DAILY_SEND_TIME = os.getenv('DAILY_SEND_TIME', '23:59')  # Format: HH:MM

RTSP_URL = os.getenv('RTSP_URL')
FALLBACK_VIDEO = os.getenv('FALLBACK_VIDEO', '').strip()  # set to a .mp4 path for debug; empty = no fallback
resolution = ast.literal_eval(os.getenv("SCREEN_RESOLUTION"))

# Line coordinates (support multiple gates)
POINT_AXIS = os.getenv('POINT_AXIS', 'X')
DETECTION_STYLE = os.getenv('DETECTION_STYLE', 'dot').lower()

LINE_OFFSET = os.getenv('LINE_OFFSET', 'X')
LINE_OFFSET_AMOUNT = int(os.getenv('LINE_OFFSET_AMOUNT', 5))

DOT_OFFSET = os.getenv('DOT_OFFSET', 'Y')
DOT_OFFSET_AMOUNT = int(os.getenv('DOT_OFFSET_AMOUNT', 0))

# Detection mode: 'line_crossing' (default) or 'zone'
DETECTION_MODE = os.getenv('DETECTION_MODE', 'line_crossing').lower()

# Swap IN/OUT detection order
# False = Cross OUT line first, then IN line to count IN (default)
# True = Cross IN line first, then OUT line to count IN
SWAP_IN_OUT = os.getenv('SWAP_IN_OUT', 'false').lower() == 'true'

# Merge all gates into one logical gate
# When true, crossing ANY in_line then ANY out_line (from any gate) counts as a single event
MERGE_GATES = os.getenv('MERGE_GATES', 'false').lower() == 'true'


def _compute_offset_line(base_line, offset_value, axis):
    """Compute an offset line from base_line along the given axis (X or Y)."""
    if axis == 'X':
        return [
            (base_line[0][0] + offset_value, base_line[0][1]),
            (base_line[1][0] + offset_value, base_line[1][1]),
        ]
    elif axis == 'Y':
        return [
            (base_line[0][0], base_line[0][1] + offset_value),
            (base_line[1][0], base_line[1][1] + offset_value),
        ]
    else:
        # If LINE_OFFSET is not recognized, just return the base line
        return base_line


def load_line_pairs_from_env():
    """Load dynamic line pairs from environment variables.

    Pairs are defined alphabetically:
      - (lineA, lineB) -> first gate
      - (lineC, lineD) -> second gate
      - (lineE, lineF) -> third gate
      - and so on...

    Rules:
      - If only the first line of a pair exists (e.g. lineA, but no lineB),
        the second line is generated using LINE_OFFSET and LINE_OFFSET_AMOUNT.
      - If both lines exist (e.g. lineC and lineD), they are used as-is.
      - If neither exists, that pair is skipped.
    """
    line_pairs = []

    # Go over letters in pairs: (A,B), (C,D), (E,F), ...
    letters = string.ascii_uppercase
    for i in range(0, len(letters), 2):
        first_letter = letters[i]
        # Ensure we have a second letter for the pair
        if i + 1 >= len(letters):
            break
        second_letter = letters[i + 1]

        first_name = f"line{first_letter}"
        second_name = f"line{second_letter}"

        first_val = os.getenv(first_name)
        second_val = os.getenv(second_name)

        # Skip if nothing defined for this pair
        if first_val is None and second_val is None:
            continue

        # Require at least the first line of the pair
        if first_val is None:
            logging.warning(
                f"{second_name} is set but {first_name} is missing. "
                f"Skipping this pair."
            )
            continue

        try:
            first_line = ast.literal_eval(first_val)
        except Exception as e:
            logging.error(f"Failed to parse {first_name} from env: {e}")
            continue

        if second_val is not None:
            # Use explicit second line from env
            try:
                second_line = ast.literal_eval(second_val)
            except Exception as e:
                logging.error(f"Failed to parse {second_name} from env: {e}")
                continue
        else:
            # Generate second line from first using offset
            second_line = _compute_offset_line(first_line, LINE_OFFSET_AMOUNT, LINE_OFFSET)

        line_pairs.append(
            {
                "in_name": first_name,
                "out_name": second_name,
                "in_line": first_line,
                "out_line": second_line,
            }
        )

    if not line_pairs:
        raise RuntimeError(
            "No valid line pairs found in environment. "
            "Please define at least 'lineA' (and optionally 'lineB')."
        )

    for lp in line_pairs:
        logging.info(
            f"Loaded line pair {lp['in_name']}/{lp['out_name']}: "
            f"{lp['in_line']} -> {lp['out_line']}"
        )

    return line_pairs


def load_zones_from_env():
    """Load polygon zones from environment variables (zoneA, zoneB, ...)."""
    zones = []
    for letter in string.ascii_uppercase:
        val = os.getenv(f'zone{letter}')
        if not val:
            break
        try:
            pts = ast.literal_eval(val)
            pts_array = np.array(pts, dtype=np.float32)
            if len(pts_array) < 3:
                logging.warning(f'zone{letter} has fewer than 3 points, skipping')
                continue
            zones.append({'name': f'zone{letter}', 'polygon': pts_array})
            logging.info(f'Loaded zone{letter} with {len(pts_array)} vertices')
        except Exception as e:
            logging.error(f'Failed to parse zone{letter}: {e}')
    return zones


# Mode-conditional startup
if DETECTION_MODE == 'line_crossing':
    LINE_PAIRS = load_line_pairs_from_env()
    logging.info(f"Total line pairs loaded: {len(LINE_PAIRS)}")
else:
    LINE_PAIRS = []

if DETECTION_MODE == 'zone':
    ZONES = load_zones_from_env()
    if not ZONES:
        raise RuntimeError(
            "DETECTION_MODE=zone but no zone polygons defined. "
            "Define at least 'zoneA' in the environment."
        )
else:
    ZONES = []

logging.info(f"DETECTION_MODE = {DETECTION_MODE}")
logging.info(f"SWAP_IN_OUT = {SWAP_IN_OUT} ({'IN line first → count IN' if SWAP_IN_OUT else 'OUT line first → count IN'})")
logging.info(f"MERGE_GATES = {MERGE_GATES} ({'all gates unified' if MERGE_GATES else 'gates isolated'})")


# Crop area: defines the rectangle sent to the model.
# Format: [(x1,y1),(x2,y2)] top-left → bottom-right in SCREEN_RESOLUTION pixels.
# If not set, uses full frame.
_crop_area_raw = os.getenv('CROP_AREA', '').strip()
CROP_X1, CROP_Y1, CROP_X2, CROP_Y2 = 0, 0, None, None
if _crop_area_raw:
    try:
        _crop_pts = ast.literal_eval(_crop_area_raw)
        CROP_X1, CROP_Y1 = int(_crop_pts[0][0]), int(_crop_pts[0][1])
        CROP_X2, CROP_Y2 = int(_crop_pts[1][0]), int(_crop_pts[1][1])
        logging.info(f"Crop area: ({CROP_X1},{CROP_Y1}) → ({CROP_X2},{CROP_Y2})")
    except Exception as e:
        logging.warning(f"Failed to parse CROP_AREA, using full frame: {e}")
else:
    logging.info("No CROP_AREA set, detection uses full frame")

# Image quality settings
CROP_PADDING = 30
MIN_CROP_SIZE = (128, 128)
JPEG_QUALITY = int(os.getenv('JPEG_QUALITY', 70))  # Lower quality = faster encoding, smaller payload

# INFERENCE (Triton) CONFIG
YOLO_CONFIDENCE = float(os.getenv('YOLO_CONFIDENCE', 0.3))  # Confidence threshold (0.0-1.0)
YOLO_IOU = float(os.getenv('YOLO_IOU', 0.3))  # NMS IoU (raw-output fallback path only)
TRITON_URL = os.getenv('TRITON_URL', 'triton:8001')

_legacy_model = os.getenv('YOLO_MODEL', 'yolo11n.pt')
_default_triton_model = os.path.splitext(os.path.basename(_legacy_model))[0] + '_640'
TRITON_MODEL = os.getenv('TRITON_MODEL', _default_triton_model)
if not os.getenv('TRITON_MODEL'):
    logging.warning(
        f"TRITON_MODEL not set — derived '{TRITON_MODEL}' from legacy YOLO_MODEL={_legacy_model}"
    )

# ADDITIONAL DETECTION (optional, run alongside person counting on the same frame)
PEOPLE_COUNTING_TAG = os.getenv('PEOPLE_COUNTING_TAG', 'info')

APD_ENABLED = os.getenv('APD_ENABLED', 'false').lower() == 'true'
APD_MODEL = os.getenv('APD_MODEL', '')
APD_CONFIDENCE = float(os.getenv('APD_CONFIDENCE', 0.3))
APD_TAG = os.getenv('APD_TAG', 'alarm')
if APD_ENABLED and not APD_MODEL:
    logging.warning("APD_ENABLED=true but APD_MODEL is not set — APD detection will be disabled")
    APD_ENABLED = False

FIRE_SMOKE_ENABLED = os.getenv('FIRE_SMOKE_ENABLED', 'false').lower() == 'true'
FIRE_SMOKE_MODEL = os.getenv('FIRE_SMOKE_MODEL', '')
FIRE_SMOKE_CONFIDENCE = float(os.getenv('FIRE_SMOKE_CONFIDENCE', 0.3))
FIRE_TAG = os.getenv('FIRE_TAG', 'alarm')
SMOKE_TAG = os.getenv('SMOKE_TAG', 'alarm')
FIRE_SMOKE_COOLDOWN_MINUTES = float(os.getenv('FIRE_SMOKE_COOLDOWN_MINUTES', 5))
if FIRE_SMOKE_ENABLED and not FIRE_SMOKE_MODEL:
    logging.warning("FIRE_SMOKE_ENABLED=true but FIRE_SMOKE_MODEL is not set — Fire/Smoke detection will be disabled")
    FIRE_SMOKE_ENABLED = False

for _dep in ('YOLO_IMGSZ', 'ENABLE_NVDEC', 'YOLO_DEVICE'):
    if os.getenv(_dep):
        logging.warning(
            f"{_dep} is deprecated and ignored: inference runs on the Triton server "
            f"and the slim client image uses software video decode."
        )

# PERFORMANCE
FPS_LIMIT = float(os.getenv('FPS_LIMIT', '0'))  # 0 = no limit, >0 = max processing FPS
FRAME_INTERVAL = 1.0 / FPS_LIMIT if FPS_LIMIT > 0 else 0
FRAME_SKIP = max(1, int(os.getenv('FRAME_SKIP', '2')))  # Process 1 out of every N frames (min 1)

# DEBUG MODE
DEBUG_MODE = os.getenv('DEBUG_MODE', 'true').lower() == 'true'

# ANNOTATED STREAM — serve annotated MJPEG on this port (0 = disabled)
ANNOTATED_STREAM = os.getenv('ANNOTATED_STREAM', 'false').strip().lower() in ('true', '1', 'yes')
STREAM_PORT = int(os.getenv('STREAM_PORT', '8090')) if ANNOTATED_STREAM else 0
STREAM_JPEG_QUALITY = int(os.getenv('STREAM_JPEG_QUALITY', '50'))
