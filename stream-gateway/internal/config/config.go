// Package config loads stream-gateway's process configuration from
// environment variables — same convention python-counting/counting_config.py
// and the dashboard use (plain env vars, no config file for process-level
// settings; per-camera settings come through the management API instead).
package config

import (
	"os"
	"strconv"
	"time"
)

// Config holds the process-wide settings read once at startup.
type Config struct {
	// ListenAddr is the single HTTP server address serving the management
	// API (/api/v1/...) and the media endpoints (/hls/, /mse/, /webrtc/) —
	// one port, matching this stack's existing services (Triton aside,
	// which needs 3 for unrelated protocol reasons).
	ListenAddr string

	// PublicBaseURL is the browser-resolvable base URL used to build the
	// URLs returned by GET /api/v1/cameras/{code}/urls (e.g.
	// "http://192.168.1.50:8555"). This is deliberately distinct from
	// ListenAddr: ListenAddr is what this process binds to inside its
	// container, PublicBaseURL is what a browser on the LAN can reach.
	PublicBaseURL string

	// DefaultIdleTimeout is how long an on-demand camera source stays
	// connected after its last viewer disconnects before the upstream RTSP
	// connection is torn down.
	DefaultIdleTimeout time.Duration

	// WebRTCUDPMuxPort is the single fixed UDP port all WebRTC sessions
	// share (via pion's ICEUDPMux) — keeps the compose port list static
	// instead of needing an ephemeral port range.
	WebRTCUDPMuxPort int
}

func getEnv(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func getEnvInt(key string, def int) int {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

func getEnvDuration(key string, def time.Duration) time.Duration {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	secs, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return time.Duration(secs) * time.Second
}

// Load reads Config from the process environment.
func Load() Config {
	return Config{
		ListenAddr:         getEnv("LISTEN_ADDR", ":8555"),
		PublicBaseURL:      getEnv("PUBLIC_BASE_URL", "http://localhost:8555"),
		DefaultIdleTimeout: getEnvDuration("DEFAULT_IDLE_TIMEOUT_SECONDS", 30*time.Second),
		WebRTCUDPMuxPort:   getEnvInt("WEBRTC_UDP_MUX_PORT", 8189),
	}
}
