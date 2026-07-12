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
	if err := http.ListenAndServe(cfg.ListenAddr, mux); err != nil {
		log.Fatalf("server error: %v", err)
	}
}
