// Command stream-gateway ingests each registered camera's RTSP stream once
// and re-serves it to browsers as HLS, MSE-over-websocket, and WebRTC/WHEP.
// Cameras are registered dynamically via the management API
// (PUT/DELETE /api/v1/cameras/{code}) — the dashboard is the source of
// truth and pushes config here on every relevant device save, rather than
// this process reading any config file of its own.
package main

import (
	"fmt"
	"log"
	"net"
	"net/http"

	"github.com/pion/logging"
	pionwebrtc "github.com/pion/webrtc/v4"

	"stream-gateway/internal/api"
	"stream-gateway/internal/camera"
	"stream-gateway/internal/config"
	"stream-gateway/internal/media"
)

// newWebRTCSettingEngine binds one fixed UDP port that every camera's every
// WHEP session shares (via pion's ICE UDP mux) — the same trick mediamtx
// uses to avoid needing an ephemeral port range published in compose.
func newWebRTCSettingEngine(udpMuxPort int) (pionwebrtc.SettingEngine, error) {
	var settingEngine pionwebrtc.SettingEngine

	udpConn, err := net.ListenUDP("udp4", &net.UDPAddr{Port: udpMuxPort})
	if err != nil {
		return settingEngine, fmt.Errorf("webrtc UDP mux port %d: %w", udpMuxPort, err)
	}

	logger := logging.NewDefaultLoggerFactory().NewLogger("ice")
	settingEngine.SetICEUDPMux(pionwebrtc.NewICEUDPMux(logger, udpConn))
	return settingEngine, nil
}

// withCORS makes every endpoint usable from a browser page served by a
// different origin, which is the normal case here and not an edge case: the
// dashboard is on :3001 while this gateway is on :8555, so every hls.js
// playlist/segment XHR and every WHEP POST is cross-origin. Without these
// headers the browser blocks them outright — HLS and WebRTC silently render
// nothing while curl against the same URLs works fine.
//
// A WHEP POST (Content-Type: application/sdp) is a non-simple request, so the
// browser sends an OPTIONS preflight first; the bare ServeMux answers that with
// 405 and the request never happens. Answer it here.
//
// Origin "*" is deliberate: this serves unauthenticated LAN media on an edge
// appliance (no cookies, no credentials), and the dashboard's origin varies by
// how the operator reaches it — localhost, LAN IP, or WireGuard IP — so
// pinning a single origin would just reintroduce the manual-configuration
// problem this replaced.
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func main() {
	cfg := config.Load()

	settingEngine, err := newWebRTCSettingEngine(cfg.WebRTCUDPMuxPort)
	if err != nil {
		log.Fatalf("webrtc setup: %v", err)
	}

	mgr := camera.NewManager(settingEngine)

	mux := http.NewServeMux()
	api.Mount(mux, mgr, cfg)
	media.Mount(mux, mgr)

	log.Printf("stream-gateway listening on %s (public base URL: %s, webrtc UDP mux :%d)",
		cfg.ListenAddr, cfg.PublicBaseURL, cfg.WebRTCUDPMuxPort)
	if err := http.ListenAndServe(cfg.ListenAddr, withCORS(mux)); err != nil {
		log.Fatalf("server error: %v", err)
	}
}
