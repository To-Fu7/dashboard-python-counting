"""Mutable runtime state shared across modules — the module-level globals of the
legacy main.py, kept in one place so counting/db/mqtt modules mutate the same
values (access as `state.person_in` etc., never `from app_state import person_in`).
"""
from collections import defaultdict

# Counting state machines
last_points = defaultdict(lambda: (None, None))
state_in = defaultdict(lambda: False)
state_out = defaultdict(lambda: False)
prev_intersecting = defaultdict(lambda: False)
zone_inside_prev = defaultdict(lambda: False)  # key: (track_id, zone_index)
class_counts = defaultdict(int)

# Hourly resample tracking
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

# Store latest person coordinates for MQTT and bbox overlay
latest_person_coordinates = []

# APD violation tracking: track_id -> set of violation labels already alerted
# (persists for the life of the track; cleared on tracker reset)
apd_alerted_tracks = defaultdict(set)

# APD unique-person-per-hour tracking: track_ids already counted toward
# apd_hourly's "unique_persons" counter this hour (cleared on hour rotation
# and on APD tracker reset — a reset tracker recycles ids, and a new hour
# should start its unique count from zero).
apd_unique_this_hour = set()

# Fire/Smoke cooldown: label -> last alert datetime
firesmoke_last_alert = {}

# Face recognition: track_ids already alerted (insider-with-name or intruder)
# for the life of that track — one verdict per track, ever (persists until
# tracker reset, same as apd_alerted_tracks).
face_alerted_tracks = set()

# Best-shot buffering: track_id -> list of (quality_score, crop, box) sightings
# collected so far, up to cfg.FACE_CAPTURE_FRAMES, before committing to the
# highest-quality one for embedding/matching (see detection.face.collect_best_shot).
face_candidates = defaultdict(list)
