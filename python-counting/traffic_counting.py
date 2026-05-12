import os
import ast
import math
import string
import logging
import cv2
import cvzone
from collections import defaultdict


def _compute_offset_line(base_line, offset_value, axis):
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
    return base_line


def load_line_pairs_from_env():
    """
    Load line pairs from env (lineA/lineB, lineC/lineD, ...).
    If only the first line exists, second is auto-generated via LINE_OFFSET.
    """
    line_offset = os.getenv('LINE_OFFSET', 'X')
    line_offset_amount = int(os.getenv('LINE_OFFSET_AMOUNT', 5))
    line_pairs = []

    for i in range(0, len(string.ascii_uppercase), 2):
        first_letter = string.ascii_uppercase[i]
        if i + 1 >= len(string.ascii_uppercase):
            break
        second_letter = string.ascii_uppercase[i + 1]

        first_val = os.getenv(f'line{first_letter}')
        second_val = os.getenv(f'line{second_letter}')

        if first_val is None and second_val is None:
            continue
        if first_val is None:
            logging.warning(f'line{second_letter} set but line{first_letter} missing, skipping pair')
            continue

        try:
            first_line = ast.literal_eval(first_val)
        except Exception as e:
            logging.error(f'Failed to parse line{first_letter}: {e}')
            continue

        if second_val is not None:
            try:
                second_line = ast.literal_eval(second_val)
            except Exception as e:
                logging.error(f'Failed to parse line{second_letter}: {e}')
                continue
        else:
            second_line = _compute_offset_line(first_line, line_offset_amount, line_offset)

        line_pairs.append({
            'in_name': f'line{first_letter}',
            'out_name': f'line{second_letter}',
            'in_line': first_line,
            'out_line': second_line,
        })
        logging.info(f'Loaded line{first_letter}/line{second_letter}: {first_line} -> {second_line}')

    if not line_pairs:
        raise RuntimeError("No valid line pairs found. Define at least 'lineA' in the environment.")

    return line_pairs


def is_crossing_line(p1, p2, line):
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


class TrafficCounter:
    """Line-crossing IN/OUT counter. Manages per-track state internally."""

    def __init__(self, line_pairs, cfg):
        self.line_pairs = line_pairs
        self.detection_style = cfg['detection_style']   # 'dot' | 'line'
        self.point_axis = cfg['point_axis']             # 'X' | 'Y'
        self.swap_in_out = cfg['swap_in_out']           # bool
        self.merge_gates = cfg['merge_gates']           # bool
        self.dot_offset_amount = cfg['dot_offset_amount']
        self.debug_mode = cfg['debug_mode']

        self._last_points = defaultdict(lambda: (None, None))
        self._state_in = defaultdict(bool)
        self._state_out = defaultdict(bool)
        self._prev_intersecting = defaultdict(bool)

    def reset(self):
        self._last_points.clear()
        self._state_in.clear()
        self._state_out.clear()
        self._prev_intersecting.clear()

    def _detection_points(self, x1, y1, x2, y2):
        """Return (first, second) as points (dot mode) or edge tuples (line mode)."""
        if self.detection_style == 'line':
            if self.point_axis == 'Y':
                return ((x1, y1), (x2, y1)), ((x1, y2), (x2, y2))
            else:
                return ((x1, y1), (x1, y2)), ((x2, y1), (x2, y2))
        else:
            if self.point_axis == 'Y':
                return (
                    ((x1 + x2) // 2, y1 - self.dot_offset_amount),
                    ((x1 + x2) // 2, y2 + self.dot_offset_amount),
                )
            else:
                return (
                    (x1 - self.dot_offset_amount, (y1 + y2) // 2),
                    (x2 + self.dot_offset_amount, (y1 + y2) // 2),
                )

    def process(self, x1, y1, x2, y2, track_id):
        """
        Process one person detection. Returns list of events:
          {'type': 'person_in'|'person_out', 'track_id': int, 'gate': str}
        """
        events = []
        first, second = self._detection_points(x1, y1, x2, y2)

        if self.detection_style != 'line':
            prev = self._last_points[track_id]
            if prev[0] is None:
                self._last_points[track_id] = (first, second)
                return events
            prev_top, prev_bottom = prev

        for gate_index, lp in enumerate(self.line_pairs):
            gate_key = track_id if self.merge_gates else (track_id, gate_index)
            gate_label = 'merged' if self.merge_gates else f'gate {gate_index}'

            if self.detection_style == 'line':
                in_key = (track_id, 'in') if self.merge_gates else (track_id, gate_index, 'in')
                out_key = (track_id, 'out') if self.merge_gates else (track_id, gate_index, 'out')
                touching_in = is_edge_intersecting(first[0], first[1], lp['in_line'])
                touching_out = is_edge_intersecting(second[0], second[1], lp['out_line'])
                crossed_A = touching_in and not self._prev_intersecting.get(in_key, False)
                crossed_B = touching_out and not self._prev_intersecting.get(out_key, False)
                self._prev_intersecting[in_key] = touching_in
                self._prev_intersecting[out_key] = touching_out
            else:
                crossed_A = is_crossing_line(prev_top, first, lp['in_line'])
                crossed_B = is_crossing_line(prev_bottom, second, lp['out_line'])

            if self.swap_in_out:
                if crossed_A:
                    if self._state_out.get(gate_key):
                        events.append({'type': 'person_out', 'track_id': track_id, 'gate': gate_label})
                        self._state_out[gate_key] = False
                    else:
                        self._state_in[gate_key] = True
                        logging.info(f'Person {track_id} crossed IN line of {gate_label} (waiting for Out→In)')
                elif crossed_B:
                    if self._state_in.get(gate_key):
                        events.append({'type': 'person_in', 'track_id': track_id, 'gate': gate_label})
                        self._state_in[gate_key] = False
                    else:
                        self._state_out[gate_key] = True
                        logging.info(f'Person {track_id} crossed OUT line of {gate_label} (waiting for In→Out)')
            else:
                if crossed_A:
                    if self._state_in.get(gate_key):
                        events.append({'type': 'person_in', 'track_id': track_id, 'gate': gate_label})
                        self._state_in[gate_key] = False
                    else:
                        self._state_out[gate_key] = True
                        logging.info(f'Person {track_id} crossed IN line of {gate_label} (waiting for Out→In)')
                elif crossed_B:
                    if self._state_out.get(gate_key):
                        events.append({'type': 'person_out', 'track_id': track_id, 'gate': gate_label})
                        self._state_out[gate_key] = False
                    else:
                        self._state_in[gate_key] = True
                        logging.info(f'Person {track_id} crossed OUT line of {gate_label} (waiting for In→Out)')

        if self.detection_style != 'line':
            self._last_points[track_id] = (first, second)

        return events

    def draw_overlay(self, frame):
        """Draw line pairs and IN/OUT direction arrows."""
        for lp in self.line_pairs:
            cv2.line(frame, lp['in_line'][0], lp['in_line'][1], (255, 0, 0), 4)
            cv2.line(frame, lp['out_line'][0], lp['out_line'][1], (0, 255, 255), 4)

            in_mid = ((lp['in_line'][0][0] + lp['in_line'][1][0]) // 2,
                      (lp['in_line'][0][1] + lp['in_line'][1][1]) // 2)
            out_mid = ((lp['out_line'][0][0] + lp['out_line'][1][0]) // 2,
                       (lp['out_line'][0][1] + lp['out_line'][1][1]) // 2)
            dx, dy = out_mid[0] - in_mid[0], out_mid[1] - in_mid[1]
            dist = math.sqrt(dx * dx + dy * dy)
            if dist == 0:
                continue
            ux, uy = dx / dist, dy / dist
            a_start = (int(in_mid[0] - ux * 50), int(in_mid[1] - uy * 50))
            a_end   = (int(in_mid[0] - ux * 20), int(in_mid[1] - uy * 20))
            b_start = (int(out_mid[0] + ux * 50), int(out_mid[1] + uy * 50))
            b_end   = (int(out_mid[0] + ux * 20), int(out_mid[1] + uy * 20))

            in_start, in_end = (a_start, a_end) if self.swap_in_out else (b_start, b_end)
            out_start, out_end = (b_start, b_end) if self.swap_in_out else (a_start, a_end)

            cv2.arrowedLine(frame, in_start, in_end, (0, 255, 0), 2, tipLength=0.3)
            cv2.putText(frame, 'IN', (in_start[0] - 5, in_start[1] - 10),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)
            cv2.arrowedLine(frame, out_start, out_end, (0, 0, 255), 2, tipLength=0.3)
            cv2.putText(frame, 'OUT', (out_start[0] - 10, out_start[1] - 10),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 255), 2)

    def draw_person(self, frame, x1, y1, x2, y2, track_id):
        """Draw bbox and detection points for one person."""
        cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 0, 255), 2)
        cvzone.putTextRect(frame, f'{track_id}', (x1, y1), 1, 1)
        first, second = self._detection_points(x1, y1, x2, y2)
        if self.detection_style == 'line':
            cv2.line(frame, first[0], first[1], (255, 0, 0), 2)
            cv2.line(frame, second[0], second[1], (0, 255, 255), 2)
        else:
            cv2.circle(frame, first, 4, (255, 0, 0), 2)
            cv2.circle(frame, second, 4, (0, 255, 255), 2)
