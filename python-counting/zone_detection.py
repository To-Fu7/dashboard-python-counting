import os
import ast
import string
import logging
import cv2
import numpy as np
from collections import defaultdict


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


class ZoneDetector:
    """Zone entry detector. Fires an event when a tracked person enters a zone."""

    _ZONE_COLORS = [(255, 0, 0), (0, 255, 0), (0, 0, 255), (0, 255, 255), (255, 0, 255)]

    def __init__(self, zones):
        self.zones = zones
        self._zone_inside_prev = defaultdict(bool)

    def reset(self):
        self._zone_inside_prev.clear()

    def process(self, x1, y1, x2, y2, track_id, original_frame):
        """
        Process one person detection. Returns list of zone entry events:
          {'type': 'zone_entry', 'track_id': int, 'zone': str, 'frame': annotated_frame}
        """
        events = []
        cx = int((x1 + x2) // 2)
        cy = int((y1 + y2) // 2)

        for zone_idx, zone in enumerate(self.zones):
            zone_key = (track_id, zone_idx)
            inside = cv2.pointPolygonTest(
                zone['polygon'], (float(cx), float(cy)), False
            ) >= 0
            was_inside = self._zone_inside_prev[zone_key]

            if inside and not was_inside:
                annotated = original_frame.copy()
                cv2.rectangle(annotated, (x1, y1), (x2, y2), (0, 255, 0), 2)
                cv2.putText(annotated, f'ID:{track_id}', (x1, max(0, y1 - 8)),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 0), 2)
                events.append({
                    'type': 'zone_entry',
                    'track_id': track_id,
                    'zone': zone['name'],
                    'frame': annotated,
                })
                logging.info(f'Person {track_id} entered {zone["name"]}')

            self._zone_inside_prev[zone_key] = inside

        return events

    def draw_overlay(self, frame):
        """Draw zone polygons with semi-transparent fill."""
        for zi, zone in enumerate(self.zones):
            color = self._ZONE_COLORS[zi % len(self._ZONE_COLORS)]
            pts = zone['polygon'].astype(np.int32).reshape((-1, 1, 2))
            overlay = frame.copy()
            cv2.fillPoly(overlay, [pts], color)
            cv2.addWeighted(overlay, 0.25, frame, 0.75, 0, frame)
            cv2.polylines(frame, [pts], True, color, 2)
            label_pt = tuple(zone['polygon'][0].astype(int))
            cv2.putText(frame, zone['name'], label_pt,
                        cv2.FONT_HERSHEY_SIMPLEX, 0.6, color, 2)

    def draw_person(self, frame, x1, y1, x2, y2, track_id):
        """Draw bbox for one person in zone mode."""
        import cvzone
        cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 0, 255), 2)
        cvzone.putTextRect(frame, f'{track_id}', (x1, y1), 1, 1)
