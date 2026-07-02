"""Line-crossing and zone counting logic — the per-track state machine extracted
verbatim from the legacy main.py inner loop (lines ~1300-1506). Only mechanical
changes: globals -> app_state attributes, env constants -> counting_config.

process_track() consumes one tracked person box (full-frame coordinates, stable
track_id from ByteTrack) and mutates counters / fires DB + MQTT events exactly
like the old code. It returns the detection geometry so the caller can draw it.
"""
import logging

import cv2

import app_state as state
import counting_config as cfg
from outputs.db_worker import db_queue_write
from outputs.mqtt_out import send_person_in_mqtt


def is_crossing_line(p1, p2, line):
    """Check if segment p1-p2 crosses the given line using cross product"""
    if p1 is None or p2 is None:
        return False
    try:
        a, b = line[0], line[1]
        d1 = (b[0]-a[0])*(p1[1]-a[1]) - (b[1]-a[1])*(p1[0]-a[0])
        d2 = (b[0]-a[0])*(p2[1]-a[1]) - (b[1]-a[1])*(p2[0]-a[0])
        if d1 * d2 >= 0:
            return False
        d3 = (p2[0]-p1[0])*(a[1]-p1[1]) - (p2[1]-p1[1])*(a[0]-p1[0])
        d4 = (p2[0]-p1[0])*(b[1]-p1[1]) - (p2[1]-p1[1])*(b[0]-p1[0])
        return d3 * d4 < 0
    except Exception:
        return False


def is_edge_intersecting(edge_start, edge_end, detection_line):
    """Check if bbox edge segment intersects with the detection line using cross product"""
    try:
        p1, p2 = edge_start, edge_end
        a, b = detection_line[0], detection_line[1]
        d1 = (b[0]-a[0])*(p1[1]-a[1]) - (b[1]-a[1])*(p1[0]-a[0])
        d2 = (b[0]-a[0])*(p2[1]-a[1]) - (b[1]-a[1])*(p2[0]-a[0])
        if d1 * d2 > 0:
            return False
        d3 = (p2[0]-p1[0])*(a[1]-p1[1]) - (p2[1]-p1[1])*(a[0]-p1[0])
        d4 = (p2[0]-p1[0])*(b[1]-p1[1]) - (p2[1]-p1[1])*(b[0]-p1[0])
        return d3 * d4 <= 0
    except Exception:
        return False


def compute_geometry(x1, y1, x2, y2):
    """Detection points/edges for line_crossing mode (legacy lines 1300-1315)."""
    geom = {}
    if cfg.DETECTION_STYLE == 'line':
        if cfg.POINT_AXIS == "Y":
            geom['first_edge'] = ((x1, y1), (x2, y1))
            geom['second_edge'] = ((x1, y2), (x2, y2))
        elif cfg.POINT_AXIS == "X":
            geom['first_edge'] = ((x1, y1), (x1, y2))
            geom['second_edge'] = ((x2, y1), (x2, y2))
    else:
        if cfg.POINT_AXIS == "Y":
            geom['first_point'] = ((x1 + x2) // 2, y1 - cfg.DOT_OFFSET_AMOUNT)
            geom['second_point'] = ((x1 + x2) // 2, y2 + cfg.DOT_OFFSET_AMOUNT)
        elif cfg.POINT_AXIS == "X":
            geom['first_point'] = (x1 - cfg.DOT_OFFSET_AMOUNT, (y1 + y2) // 2)
            geom['second_point'] = (x2 + cfg.DOT_OFFSET_AMOUNT, (y1 + y2) // 2)
    return geom


def _count_in(track_id, gate_label, original_frame):
    state.person_in += 1
    state.interval_person_in += 1
    state.resample_hour_in += 1
    state.class_counts['in'] = state.person_in

    # Async DB update (non-blocking)
    db_queue_write(
        "UPDATE person_inout SET total_in = %s WHERE id = %s",
        (state.person_in, state.record_id)
    )

    send_person_in_mqtt(original_frame, state.record_id, "person_in")

    logging.info(
        f'Person {track_id} IN through {gate_label} - Total IN: {state.person_in}'
    )


def _count_out(track_id, gate_label, original_frame):
    state.person_out += 1
    state.interval_person_out += 1
    state.resample_hour_out += 1
    state.class_counts['out'] = state.person_out

    # Async DB update (non-blocking)
    db_queue_write(
        "UPDATE person_inout SET total_out = %s WHERE id = %s",
        (state.person_out, state.record_id)
    )

    send_person_in_mqtt(original_frame, state.record_id, "person_out")

    logging.info(
        f'Person {track_id} OUT through {gate_label} - Total OUT: {state.person_out}'
    )


def process_track(track_id, box, original_frame):
    """Run the counting state machine for one tracked person.

    box: [x1, y1, x2, y2] already adjusted to full-frame coordinates.
    Returns the geometry dict (for drawing) in line_crossing mode, else {}.
    """
    x1, y1, x2, y2 = box
    geom = {}

    if cfg.DETECTION_MODE == 'line_crossing':
        geom = compute_geometry(x1, y1, x2, y2)
        first_edge = geom.get('first_edge')
        second_edge = geom.get('second_edge')
        first_point = geom.get('first_point')
        second_point = geom.get('second_point')

        # Determine if crossing detection can run
        can_check_crossing = True
        prev_top = prev_bottom = None
        if cfg.DETECTION_STYLE != 'line':
            prev_points = state.last_points[track_id]
            if prev_points[0] is None or prev_points[1] is None:
                can_check_crossing = False
            else:
                prev_top, prev_bottom = prev_points

        if can_check_crossing:
            # Check crossings against all line pairs
            for gate_index, lp in enumerate(cfg.LINE_PAIRS):
                gate_key = track_id if cfg.MERGE_GATES else (track_id, gate_index)
                gate_label = "merged" if cfg.MERGE_GATES else f"gate {gate_index}"

                if cfg.DETECTION_STYLE == 'line':
                    # Edge intersection with entry-event detection
                    touching_in = is_edge_intersecting(first_edge[0], first_edge[1], lp["in_line"])
                    touching_out = is_edge_intersecting(second_edge[0], second_edge[1], lp["out_line"])
                    in_key = (track_id, 'in') if cfg.MERGE_GATES else (track_id, gate_index, 'in')
                    out_key = (track_id, 'out') if cfg.MERGE_GATES else (track_id, gate_index, 'out')
                    crossed_A = touching_in and not state.prev_intersecting.get(in_key, False)
                    crossed_B = touching_out and not state.prev_intersecting.get(out_key, False)
                    state.prev_intersecting[in_key] = touching_in
                    state.prev_intersecting[out_key] = touching_out
                else:
                    # Point movement crossing detection
                    crossed_A = is_crossing_line(prev_top, first_point, lp["in_line"])
                    crossed_B = is_crossing_line(prev_bottom, second_point, lp["out_line"])

                # SWAP_IN_OUT swaps which line triggers IN vs OUT
                # False (default): Cross B first, then A = IN | Cross A first, then B = OUT
                # True (swapped):  Cross A first, then B = IN | Cross B first, then A = OUT
                if cfg.SWAP_IN_OUT:
                    # Swapped mode
                    if crossed_A:
                        if state.state_out.get(gate_key):
                            _count_out(track_id, gate_label, original_frame)
                            state.state_out[gate_key] = False
                        else:
                            state.state_in[gate_key] = True
                            logging.info(
                                f'Person {track_id} crossed IN line of {gate_label} (preparing for In)'
                            )
                    elif crossed_B:
                        if state.state_in.get(gate_key):
                            _count_in(track_id, gate_label, original_frame)
                            state.state_in[gate_key] = False
                        else:
                            state.state_out[gate_key] = True
                            logging.info(
                                f'Person {track_id} crossed OUT line of {gate_label} (preparing for Out)'
                            )
                else:
                    # Default mode
                    if crossed_A:
                        if state.state_in.get(gate_key):
                            _count_in(track_id, gate_label, original_frame)
                            state.state_in[gate_key] = False
                        else:
                            state.state_out[gate_key] = True
                            logging.info(
                                f'Person {track_id} crossed IN line of {gate_label} (preparing for Out)'
                            )
                    elif crossed_B:
                        if state.state_out.get(gate_key):
                            _count_out(track_id, gate_label, original_frame)
                            state.state_out[gate_key] = False
                        else:
                            state.state_in[gate_key] = True
                            logging.info(
                                f'Person {track_id} crossed OUT line of {gate_label} (preparing for In)'
                            )

        if cfg.DETECTION_STYLE != 'line':
            state.last_points[track_id] = (first_point, second_point)

    elif cfg.DETECTION_MODE == 'zone':
        cx = int((x1 + x2) // 2)
        cy = int((y1 + y2) // 2)

        for zone_idx, zone in enumerate(cfg.ZONES):
            zone_key = (track_id, zone_idx)
            inside = cv2.pointPolygonTest(
                zone['polygon'], (float(cx), float(cy)), False
            ) >= 0
            was_inside = state.zone_inside_prev[zone_key]

            if inside and not was_inside:
                # ENTRY EVENT — annotate a copy of the frame
                state.person_in += 1
                state.interval_person_in += 1
                state.resample_hour_in += 1
                state.class_counts['in'] = state.person_in

                db_queue_write(
                    "UPDATE person_inout SET total_in = %s WHERE id = %s",
                    (state.person_in, state.record_id)
                )

                annotated = original_frame.copy()
                cv2.rectangle(annotated, (x1, y1), (x2, y2), (0, 255, 0), 2)
                cv2.putText(
                    annotated, f'ID:{track_id}',
                    (x1, max(0, y1 - 8)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2
                )

                send_person_in_mqtt(annotated, state.record_id, "zone_entry")
                logging.info(
                    f'Person {track_id} entered {zone["name"]} '
                    f'— Total IN: {state.person_in}'
                )

            state.zone_inside_prev[zone_key] = inside

    return geom
