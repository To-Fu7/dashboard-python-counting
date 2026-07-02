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
