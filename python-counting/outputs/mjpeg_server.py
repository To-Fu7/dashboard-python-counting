"""Annotated MJPEG HTTP server — extracted verbatim from legacy main.py
(_MJPEGHandler, _start_mjpeg_server). Serves multipart/x-mixed-replace on
cfg.STREAM_PORT; frames are pushed only when viewers are connected.
"""
import logging
import socketserver
import threading
import time
from http.server import BaseHTTPRequestHandler

import counting_config as cfg

_stream_frame: bytes | None = None
_stream_lock = threading.Lock()
_stream_clients = 0  # active MJPEG viewer count
_stream_clients_lock = threading.Lock()


def viewer_count() -> int:
    return _stream_clients


def push_frame(jpeg_bytes: bytes):
    global _stream_frame
    with _stream_lock:
        _stream_frame = jpeg_bytes


class _MJPEGHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path not in ('/', '/stream'):
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=frame')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Connection', 'keep-alive')
        self.end_headers()
        global _stream_clients
        with _stream_clients_lock:
            _stream_clients += 1
        try:
            while True:
                with _stream_lock:
                    frame = _stream_frame
                if frame is not None:
                    header = (
                        b'--frame\r\n'
                        b'Content-Type: image/jpeg\r\n'
                        + f'Content-Length: {len(frame)}\r\n\r\n'.encode()
                    )
                    self.wfile.write(header + frame + b'\r\n')
                    self.wfile.flush()
                time.sleep(0.04)  # ~25 fps cap
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            with _stream_clients_lock:
                _stream_clients -= 1

    def log_message(self, format, *args):  # suppress access logs
        pass


def _start_mjpeg_server():
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(('', cfg.STREAM_PORT), _MJPEGHandler) as srv:
        logging.info(f"Annotated MJPEG stream serving on :{cfg.STREAM_PORT}")
        srv.serve_forever()


def start_stream_server_if_enabled():
    if cfg.STREAM_PORT > 0:
        threading.Thread(target=_start_mjpeg_server, daemon=True).start()
