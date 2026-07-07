"""MQTT outputs — per-event JPEG crop publish and interval/daily count publish.
Extracted verbatim from legacy main.py (init_mqtt, send_person_in_mqtt,
send_interval_mqtt_data, should_send_interval_mqtt).
"""
import base64
import datetime
import json
import logging

import cv2
import paho.mqtt.client as mqtt

import app_state as state
import counting_config as cfg
from outputs.db_worker import db_queue_write

mqtt_client = None


def init_mqtt():
    """Initialize MQTT client"""
    global mqtt_client
    try:
        mqtt_client = mqtt.Client()

        if cfg.MQTT_USERNAME and cfg.MQTT_PASSWORD:
            mqtt_client.username_pw_set(cfg.MQTT_USERNAME, cfg.MQTT_PASSWORD)

        def on_connect(client, userdata, flags, rc):
            if rc == 0:
                logging.info("Connected to MQTT broker successfully")
            else:
                logging.error(f"Failed to connect to MQTT broker, return code {rc}")

        def on_disconnect(client, userdata, rc):
            logging.warning("Disconnected from MQTT broker")

        mqtt_client.on_connect = on_connect
        mqtt_client.on_disconnect = on_disconnect

        mqtt_client.connect(cfg.MQTT_BROKER, cfg.MQTT_PORT, 60)
        mqtt_client.loop_start()

    except Exception as e:
        logging.error(f"Failed to initialize MQTT: {e}")
        mqtt_client = None


def shutdown_mqtt():
    if mqtt_client:
        mqtt_client.loop_stop()
        mqtt_client.disconnect()


def _publish_image_event(image, extra_fields, log_label):
    """Shared guard/encode/publish path for image-carrying MQTT events.
    extra_fields are merged into the common device/timestamp envelope."""
    if cfg.DEBUG_MODE:
        logging.info(f"DEBUG_MODE: Skipping MQTT send for {log_label}")
        return

    if mqtt_client is None:
        logging.warning(f"MQTT client not initialized, skipping {log_label}")
        return

    try:
        _, buffer = cv2.imencode('.jpg', image, [cv2.IMWRITE_JPEG_QUALITY, cfg.JPEG_QUALITY])

        payload = {
            "device_id": cfg.device_id,
            "device_code": cfg.device_code,
            "device_name": cfg.device_name,
            "timestamp": datetime.datetime.now(cfg.local_tz).isoformat(),
            **extra_fields,
            "image": base64.b64encode(buffer.tobytes()).decode('utf-8'),
        }

        result = mqtt_client.publish(cfg.MQTT_TOPIC, json.dumps(payload), qos=1)
        if result.rc == mqtt.MQTT_ERR_SUCCESS:
            logging.info(f"{log_label} sent via MQTT")
        else:
            logging.error(f"Failed to send MQTT message ({log_label}), error code: {result.rc}")
    except Exception as e:
        logging.error(f"Error sending MQTT message ({log_label}): {e}")


def send_person_in_mqtt(cropped_image, record_id, event_type="person_in"):
    """Send cropped image via MQTT when person enters"""
    _publish_image_event(
        cropped_image,
        {
            "record_id": record_id,
            "event": event_type,
            "type": "people_counting",
            "tag": cfg.PEOPLE_COUNTING_TAG,
        },
        f"person {event_type} (record {record_id})",
    )


def send_detection_event_mqtt(image, detection_type, tag, label, confidence, track_id=None):
    """Publish an APD/fire/smoke event. Reuses MQTT_TOPIC (distinguished by
    the 'type' field) rather than a separate topic, per design decision."""
    _publish_image_event(
        image,
        {
            "event": f"{detection_type}_detected",
            "type": detection_type,
            "tag": tag,
            "label": label,
            "confidence": confidence,
            "track_id": track_id,
        },
        f"{detection_type} event (label={label}, conf={confidence:.2f})",
    )


def send_interval_mqtt_data():
    """Send interval data via MQTT (every 5 minutes and at 23:59)"""
    if cfg.DEBUG_MODE:
        return

    if mqtt_client is None:
        logging.warning("MQTT client not initialized, skipping interval data")
        # mark as sent so this fires once per interval, not on every frame
        state.last_mqtt_send = datetime.datetime.now(cfg.local_tz)
        return

    # Guard against rapid re-entry (multiple frames triggering in the same tick)
    current_time = datetime.datetime.now(cfg.local_tz)
    if state.last_mqtt_send is not None:
        elapsed = (current_time - state.last_mqtt_send).total_seconds()
        if elapsed < (cfg.MQTT_INTERVAL_MINUTES * 60) - 5:
            logging.warning(f"Skipping duplicate interval send (only {elapsed:.0f}s since last)")
            return

    # Mark send time BEFORE publish to block any concurrent calls
    state.last_mqtt_send = current_time

    # Snapshot and reset counters atomically before publish
    snapshot_in = state.interval_person_in
    snapshot_out = state.interval_person_out
    state.interval_person_in = 0
    state.interval_person_out = 0

    try:
        # Create payload with current interval counts (not total)
        payload = {
            "record_id": state.record_id,
            "device_id": cfg.device_id,
            "device_code": cfg.device_code,
            "device_name": cfg.device_name,
            "timestamp": current_time.isoformat(),
            "event": "interval_data",
            "data": {
                "interval_in": snapshot_in,
                "interval_out": snapshot_out,
                "total_in": state.person_in,  # Keep total for reference
                "total_out": state.person_out,  # Keep total for reference
                "net_count": state.person_in - state.person_out,
                "interval_net": snapshot_in - snapshot_out,
                "interval_minutes": cfg.MQTT_INTERVAL_MINUTES
            }
        }

        # Send to MQTT
        result = mqtt_client.publish(cfg.MQTT_INTERVAL_TOPIC, json.dumps(payload), qos=1)

        if result.rc == mqtt.MQTT_ERR_SUCCESS:
            logging.info(f"Interval data sent via MQTT - Interval IN: {snapshot_in}, Interval OUT: {snapshot_out}, Total IN: {state.person_in}, Total OUT: {state.person_out}")
            if state.resample_record_id is not None:
                db_queue_write(
                    "UPDATE inout_resample SET interval_in = %s, interval_out = %s, updated_at = now() WHERE id = %s",
                    (state.resample_hour_in, state.resample_hour_out, state.resample_record_id)
                )
        else:
            # Restore counters on publish failure
            state.interval_person_in += snapshot_in
            state.interval_person_out += snapshot_out
            logging.error(f"Failed to send interval MQTT data, error code: {result.rc}")

    except Exception as e:
        # Restore counters on exception
        state.interval_person_in += snapshot_in
        state.interval_person_out += snapshot_out
        logging.error(f"Error sending interval MQTT data: {e}")


def should_send_interval_mqtt():
    """Check if it's time to send interval MQTT data"""
    current_time = datetime.datetime.now(cfg.local_tz)

    # Check for daily send time (23:59)
    daily_hour, daily_minute = map(int, cfg.DAILY_SEND_TIME.split(':'))
    if (current_time.hour == daily_hour and current_time.minute == daily_minute and
            current_time.second < 10):

        # Check if we haven't sent today's daily report yet
        if (state.last_daily_send is None or
                state.last_daily_send.date() != current_time.date()):
            state.last_daily_send = current_time
            logging.info("Daily MQTT send triggered at 23:59")
            return True

    # Check for interval send (every X minutes)
    if state.last_mqtt_send is None:
        return True

    time_diff = current_time - state.last_mqtt_send
    if time_diff.total_seconds() >= (cfg.MQTT_INTERVAL_MINUTES * 60):
        return True

    return False
