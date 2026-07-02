"""Person counting service — Triton thin-client edition.

Pipeline per frame (identical to legacy except inference is remote):
    RTSP/file -> cv2 decode -> resize(SCREEN_RESOLUTION) -> crop(CROP_AREA)
    -> Triton gRPC YOLO inference (shared server, no local torch/CUDA)
    -> vendored ByteTrack (same tracker the legacy model.track() used)
    -> line-crossing / zone counting state machine (counting.py, verbatim)
    -> PostgreSQL (async worker) + MQTT events + annotated MJPEG + bbox json

Degraded mode: if Triton is unreachable the process never exits — capture stays
alive, the MJPEG stream shows "INFERENCE UNAVAILABLE", reconnection is retried
with exponential backoff (1s → 30s), and the tracker is reset after reconnect so
stale Kalman states can't produce phantom crossings.

The legacy single-file implementation is preserved at legacy/main_legacy.py.
"""
import datetime
import logging
import math
import os
import time

import cv2
import numpy as np

import app_state as state
import counting_config as cfg
import lifecycle
from counting import process_track
from inference import TritonUnavailableError, TritonYoloClient
from outputs import bbox_writer, db_worker, mjpeg_server, mqtt_out
from tracking import BYTETracker, BYTETrackerArgs, Detections

TRITON_BACKOFF_MIN_S = 1.0
TRITON_BACKOFF_MAX_S = 30.0

_imshow_available = True  # opencv-headless has no GUI; disabled on first failure


def validate_cctv_connection(rtsp_url, timeout=5):
    """Validate CCTV connection by attempting to open and read a frame"""
    if not rtsp_url or rtsp_url.strip() == '':
        logging.warning("RTSP_URL is empty or not set")
        return False

    try:
        logging.info(f"Validating CCTV connection: {rtsp_url}")
        cap = cv2.VideoCapture(rtsp_url, cv2.CAP_FFMPEG)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

        if not cap.isOpened():
            logging.warning("CCTV stream failed to open")
            cap.release()
            return False

        # Try up to 10 frames — HEVC streams often need a few frames before decode succeeds
        for _ in range(10):
            ret, frame = cap.read()
            if ret and frame is not None:
                cap.release()
                logging.info("CCTV connection validated successfully")
                return True
        cap.release()
        logging.warning("CCTV stream opened but failed to read frame after 10 attempts")
        return False

    except Exception as e:
        logging.warning(f"CCTV validation error: {e}")
        return False


def safe_destroy_windows():
    try:
        cv2.destroyAllWindows()
    except cv2.error:
        pass


def initialize_video_capture(video_source):
    """Initialize video capture (software decode — the slim image has no NVDEC)."""
    logging.info(f'Initializing video capture with source: {video_source}')
    os.environ.setdefault('OPENCV_FFMPEG_CAPTURE_OPTIONS', 'rtsp_transport;tcp')
    cap = cv2.VideoCapture(video_source, cv2.CAP_FFMPEG)
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    cap.set(cv2.CAP_PROP_FPS, 10)
    return cap


def get_video_source():
    """Get video source. Uses FALLBACK_VIDEO env for debug; no fallback if unset."""
    # Debug override: use a local video file instead of RTSP
    if cfg.FALLBACK_VIDEO:
        if os.path.exists(cfg.FALLBACK_VIDEO):
            logging.info(f"FALLBACK_VIDEO set — using {cfg.FALLBACK_VIDEO}")
            return cfg.FALLBACK_VIDEO
        else:
            logging.warning(f"FALLBACK_VIDEO={cfg.FALLBACK_VIDEO} not found, ignoring")

    if not cfg.RTSP_URL or cfg.RTSP_URL.strip() == '':
        raise RuntimeError("RTSP_URL is not set. Set FALLBACK_VIDEO to use a local video for testing.")

    if validate_cctv_connection(cfg.RTSP_URL):
        logging.info("Using CCTV stream as video source")
        return cfg.RTSP_URL

    raise RuntimeError(f"RTSP connection failed: {cfg.RTSP_URL}. Retrying in 5s... (set FALLBACK_VIDEO=1.mp4 for offline testing)")


def draw_static_overlays(frame):
    """Zones / gate lines / direction arrows / crop rectangle (legacy 1195-1251)."""
    if cfg.DETECTION_MODE == 'zone':
        zone_colors_bgr = [(255, 0, 0), (0, 255, 0), (0, 0, 255), (0, 255, 255), (255, 0, 255)]
        for zi, zone in enumerate(cfg.ZONES):
            color = zone_colors_bgr[zi % len(zone_colors_bgr)]
            pts = zone['polygon'].astype(np.int32).reshape((-1, 1, 2))
            overlay = frame.copy()
            cv2.fillPoly(overlay, [pts], color)
            cv2.addWeighted(overlay, 0.25, frame, 0.75, 0, frame)
            cv2.polylines(frame, [pts], True, color, 2)
            label_pt = tuple(zone['polygon'][0].astype(int))
            cv2.putText(frame, zone['name'], label_pt,
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)

    for lp in (cfg.LINE_PAIRS if cfg.DETECTION_MODE == 'line_crossing' else []):
        # IN LINE ( BLUE ) (BGR)
        cv2.line(frame, lp["in_line"][0], lp["in_line"][1], (255, 0, 0), 4)
        # OUT LINE ( YELLOW ) (BGR)
        cv2.line(frame, lp["out_line"][0], lp["out_line"][1], (0, 255, 255), 4)

        # Draw IN/OUT direction arrows
        in_mid = ((lp["in_line"][0][0] + lp["in_line"][1][0]) // 2,
                  (lp["in_line"][0][1] + lp["in_line"][1][1]) // 2)
        out_mid = ((lp["out_line"][0][0] + lp["out_line"][1][0]) // 2,
                   (lp["out_line"][0][1] + lp["out_line"][1][1]) // 2)
        dx = out_mid[0] - in_mid[0]
        dy = out_mid[1] - in_mid[1]
        dist = math.sqrt(dx * dx + dy * dy)
        if dist > 0:
            ux, uy = dx / dist, dy / dist
            # Arrow on in_line's outer side (pointing toward in_line)
            a_start = (int(in_mid[0] - ux * 50), int(in_mid[1] - uy * 50))
            a_end = (int(in_mid[0] - ux * 20), int(in_mid[1] - uy * 20))
            # Arrow on out_line's outer side (pointing toward out_line)
            b_start = (int(out_mid[0] + ux * 50), int(out_mid[1] + uy * 50))
            b_end = (int(out_mid[0] + ux * 20), int(out_mid[1] + uy * 20))

            if cfg.SWAP_IN_OUT:
                in_start, in_end = a_start, a_end
                out_start, out_end = b_start, b_end
            else:
                in_start, in_end = b_start, b_end
                out_start, out_end = a_start, a_end

            cv2.arrowedLine(frame, in_start, in_end, (0, 255, 0), 2, tipLength=0.3)
            cv2.putText(frame, 'IN', (in_start[0] - 5, in_start[1] - 10),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)
            cv2.arrowedLine(frame, out_start, out_end, (0, 0, 255), 2, tipLength=0.3)
            cv2.putText(frame, 'OUT', (out_start[0] - 10, out_start[1] - 10),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 255), 2)

    # Draw crop area rectangle if defined
    if cfg.CROP_X2 or cfg.CROP_Y2:
        cx2 = cfg.CROP_X2 if cfg.CROP_X2 else frame.shape[1]
        cy2 = cfg.CROP_Y2 if cfg.CROP_Y2 else frame.shape[0]
        cv2.rectangle(frame, (cfg.CROP_X1, cfg.CROP_Y1), (cx2, cy2), (0, 255, 255), 2)
        cv2.putText(frame, 'Crop Area', (cfg.CROP_X1 + 4, cfg.CROP_Y1 + 18),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)


def draw_track(frame, track_id, x1, y1, x2, y2, geom):
    """Person bbox + id + detection points/edges (legacy 1317-1327)."""
    cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 0, 255), 2)
    cv2.putText(frame, f'{track_id}', (x1, max(0, y1 - 6)),
                cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
    if cfg.DETECTION_MODE == 'line_crossing':
        if cfg.DETECTION_STYLE == 'line':
            cv2.line(frame, geom['first_edge'][0], geom['first_edge'][1], (255, 0, 0), 2)
            cv2.line(frame, geom['second_edge'][0], geom['second_edge'][1], (0, 255, 255), 2)
        else:
            cv2.circle(frame, geom['first_point'], 4, (255, 0, 0), 2)
            cv2.circle(frame, geom['second_point'], 4, (0, 255, 255), 2)


def push_degraded_frame(frame, message):
    """Show the live camera with an error banner while Triton is down."""
    if cfg.STREAM_PORT > 0 and mjpeg_server.viewer_count() > 0:
        banner = frame.copy()
        cv2.rectangle(banner, (0, 0), (banner.shape[1], 40), (0, 0, 128), -1)
        cv2.putText(banner, message, (10, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)
        ok, jpeg = cv2.imencode('.jpg', banner, [cv2.IMWRITE_JPEG_QUALITY, cfg.STREAM_JPEG_QUALITY])
        if ok:
            mjpeg_server.push_frame(jpeg.tobytes())


def reset_tracking_state(tracker):
    """After a Triton outage, drop tracker + crossing state so stale Kalman
    predictions can't generate phantom crossings on reconnect."""
    tracker.reset()
    state.last_points.clear()
    state.prev_intersecting.clear()
    state.state_in.clear()
    state.state_out.clear()
    state.zone_inside_prev.clear()


def show_debug_window(frame):
    """cv2.imshow guarded for headless builds. Returns False if user quit."""
    global _imshow_available
    if not _imshow_available:
        return True
    try:
        cv2.imshow("RGB", frame)
        if cv2.waitKey(1) & 0xFF == ord("q"):
            logging.info("User requested exit")
            return False
    except cv2.error:
        logging.warning("cv2.imshow unavailable (headless OpenCV) — debug window disabled")
        _imshow_available = False
    return True


def main():
    """Main function"""
    # Start async database worker thread
    db_worker.start_db_worker()

    # Initialize MQTT
    mqtt_out.init_mqtt()

    # Annotated MJPEG stream
    mjpeg_server.start_stream_server_if_enabled()

    # Initialize database
    if not cfg.DEBUG_MODE and not db_worker.init_db():
        return
    last_data_id = lifecycle.initialize_counts()
    if not last_data_id:
        if not cfg.DEBUG_MODE:
            logging.error("Failed to initialize database")
            return
        else:
            logging.info("DEBUG_MODE: Continuing without database initialization")

    logging.info(f"RESOLUTION = {cfg.resolution[0], cfg.resolution[1]}")
    logging.info(f"MQTT interval: {cfg.MQTT_INTERVAL_MINUTES} minutes")
    logging.info(f"Daily MQTT send time: {cfg.DAILY_SEND_TIME}")
    logging.info(f"Triton: {cfg.TRITON_URL} model={cfg.TRITON_MODEL} conf={cfg.YOLO_CONFIDENCE}")

    try:
        video_source = get_video_source()
        logging.info(f"Video source selected: {video_source}")
    except RuntimeError as e:
        logging.error(str(e))
        raise  # let outer loop retry after 5s

    # Shared-inference client + local tracker (replaces model.track)
    client = TritonYoloClient(
        cfg.TRITON_URL, cfg.TRITON_MODEL,
        conf_thresh=cfg.YOLO_CONFIDENCE, iou_thresh=cfg.YOLO_IOU, class_id=0,
    )
    tracker = BYTETracker(BYTETrackerArgs(), frame_rate=30)
    triton_backoff = TRITON_BACKOFF_MIN_S
    triton_was_down = False
    next_triton_retry = 0.0

    last_waiting_log = time.time()

    while True:
        try:
            logging.info('Initializing Service...')

            cap = initialize_video_capture(video_source)
            if not cap.isOpened():
                logging.error(f"Failed to open video source: {video_source}")
                raise Exception(f"Failed to open video source: {video_source}")
            else:
                logging.info(f'Person IN: {state.person_in}, Person OUT: {state.person_out}')
                logging.info(f"Video source opened successfully: {video_source}")
                logging.info(f"Device ID = {cfg.device_id}")

            count = 0
            last_process_time = time.time()
            fps_counter = 0
            fps_timer = time.time()
            while True:
                count += 1
                if count % cfg.FRAME_SKIP != 0:
                    cap.grab()  # Advance buffer without decoding
                    continue
                ret, frame = cap.read()

                # FPS limiting
                if cfg.FRAME_INTERVAL > 0:
                    elapsed = time.time() - last_process_time
                    if elapsed < cfg.FRAME_INTERVAL:
                        time.sleep(cfg.FRAME_INTERVAL - elapsed)
                    last_process_time = time.time()

                if not ret:
                    logging.error(f"Failed to read frame from video source: {video_source}")
                    raise Exception(f"Frame read error or video source disconnected: {video_source}")

                # Screen Resolution
                frame = cv2.resize(frame, (cfg.resolution[0], cfg.resolution[1]))

                # Crop frame to user-defined detection area before inference
                detection_frame = frame[cfg.CROP_Y1:cfg.CROP_Y2, cfg.CROP_X1:cfg.CROP_X2]

                # ---- Remote inference (degraded mode when Triton is down) ----
                if time.time() < next_triton_retry:
                    push_degraded_frame(frame, "INFERENCE UNAVAILABLE (Triton down)")
                    time.sleep(0.2)  # don't spin the decode loop at full speed
                    continue

                try:
                    dets = client.infer(detection_frame)  # [N,6] x1,y1,x2,y2,conf,cls
                except TritonUnavailableError as e:
                    logging.error(f"{e} — retrying in {triton_backoff:.0f}s (capture stays alive)")
                    next_triton_retry = time.time() + triton_backoff
                    triton_backoff = min(triton_backoff * 2, TRITON_BACKOFF_MAX_S)
                    triton_was_down = True
                    push_degraded_frame(frame, "INFERENCE UNAVAILABLE (Triton down)")
                    continue

                if triton_was_down:
                    logging.info("[Triton] Reconnected — resetting tracker state")
                    reset_tracking_state(tracker)
                    triton_was_down = False
                triton_backoff = TRITON_BACKOFF_MIN_S

                # ---- Local ByteTrack (same tracker/config as legacy model.track) ----
                tracks = tracker.update(Detections(dets[:, :4], dets[:, 4], dets[:, 5]))
                # tracks rows: x1,y1,x2,y2,track_id,score,cls,det_idx (Kalman-smoothed)

                # Draw detection overlays (only when DEBUG_MODE or someone is watching the stream)
                draw_now = cfg.DEBUG_MODE or mjpeg_server.viewer_count() > 0
                if draw_now:
                    draw_static_overlays(frame)

                # Copy frame for zone MQTT (needs clean copy before drawing)
                if cfg.DETECTION_MODE == 'zone':
                    original_frame = frame.copy()
                else:
                    original_frame = frame

                person_detected = False
                region_detections = 0

                # Clear and update person coordinates for current frame
                state.latest_person_coordinates = []

                for trk in tracks:
                    class_id = int(trk[6])
                    if class_id != 0:  # person only
                        continue
                    track_id = int(trk[4])
                    conf = float(trk[5])

                    person_detected = True
                    region_detections += 1

                    # Adjust box coordinates back to full frame
                    x1, y1, x2, y2 = (int(v) for v in trk[:4])
                    x1 += cfg.CROP_X1
                    y1 += cfg.CROP_Y1
                    x2 += cfg.CROP_X1
                    y2 += cfg.CROP_Y1

                    # Store person coordinates for MQTT / bbox overlay
                    state.latest_person_coordinates.append({
                        "track_id": track_id,
                        "x": int(x1),
                        "y": int(y1),
                        "w": int(x2 - x1),
                        "h": int(y2 - y1),
                        "confidence": conf,
                        "center_x": int((x1 + x2) // 2),
                        "center_y": int((y1 + y2) // 2)
                    })

                    # Counting state machine (line_crossing / zone) — verbatim legacy logic
                    geom = process_track(track_id, [x1, y1, x2, y2], original_frame)

                    if draw_now:
                        draw_track(frame, track_id, x1, y1, x2, y2, geom)

                # bbox overlay file for the dashboard
                bbox_writer.write_bbox_file()

                # Check for interval MQTT sending
                if mqtt_out.should_send_interval_mqtt():
                    mqtt_out.send_interval_mqtt_data()

                if not person_detected:
                    current_time = time.time()
                    if current_time - last_waiting_log >= 60:
                        logging.info("Waiting for person detection...")
                        last_waiting_log = current_time

                # Display counters
                if draw_now:
                    cv2.putText(frame, f'IN: {state.person_in}', (50, 50), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 255, 0), 2)
                    cv2.putText(frame, f'OUT: {state.person_out}', (50, 100), cv2.FONT_HERSHEY_SIMPLEX, 1, (0, 0, 255), 2)
                    cv2.putText(frame, f'Region Detections: {region_detections}', (50, 150), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 0), 2)

                # Push annotated frame to MJPEG server (only when there are active viewers)
                if cfg.STREAM_PORT > 0 and mjpeg_server.viewer_count() > 0:
                    ok, jpeg = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, cfg.STREAM_JPEG_QUALITY])
                    if ok:
                        mjpeg_server.push_frame(jpeg.tobytes())

                # SCREEN
                if cfg.DEBUG_MODE:
                    if not show_debug_window(frame):
                        return

                # Processing FPS monitor
                fps_counter += 1
                if time.time() - fps_timer >= 10.0:
                    actual_fps = fps_counter / (time.time() - fps_timer)
                    logging.info(f"Processing FPS: {actual_fps:.1f}")
                    fps_counter = 0
                    fps_timer = time.time()

                # Handle hourly resample record rotation (skip if midnight reset will handle it)
                if not lifecycle.should_reset() and state.current_tracking_hour is not None:
                    _now_hour = datetime.datetime.now(cfg.local_tz).replace(minute=0, second=0, microsecond=0)
                    if _now_hour != state.current_tracking_hour:
                        lifecycle.handle_hour_change()

                # Handle midnight reset
                if lifecycle.should_reset() and not state.is_midnight:
                    lifecycle.reset_counts()
                    state.is_midnight = True

                if not lifecycle.should_reset() and state.is_midnight:
                    state.is_midnight = False

        except Exception as error:
            logging.error(f"Error occurred: {str(error)}. Restarting in 5 seconds...")
            if 'cap' in locals():
                cap.release()
            safe_destroy_windows()
            state.last_points.clear()
            state.prev_intersecting.clear()
            state.person_history.clear()
            time.sleep(5)
            continue

    # Cleanup
    if 'cap' in locals():
        cap.release()
    safe_destroy_windows()
    mqtt_out.shutdown_mqtt()


if __name__ == "__main__":
    main()
