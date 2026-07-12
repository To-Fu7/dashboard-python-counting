// Package urls builds the browser-facing playback URLs for a camera, used
// by GET /api/v1/cameras/{code}/urls (which backs the dashboard's "Expose
// CCTV URL" button).
package urls

import "fmt"

// Set is the {hls, mse, webrtc} URL triple for one camera.
//
// NOTE: as of Phase 1, only HLS is actually served — the MSE/WebRTC paths
// below are returned so the dashboard integration (Phase 3) and UI (Phase 4)
// can be built against the final shape now, but hitting them 404s until
// Phase 2 adds the mse/webrtc packages and mounts their handlers in main.go.
type Set struct {
	HLS    string `json:"hls"`
	MSE    string `json:"mse"`
	WebRTC string `json:"webrtc"`
}

// Build returns the URL set for a camera code, given the browser-resolvable
// base URL (config.Config.PublicBaseURL).
func Build(baseURL, code string) Set {
	return Set{
		HLS:    fmt.Sprintf("%s/hls/%s/index.m3u8", baseURL, code),
		MSE:    wsURL(baseURL, fmt.Sprintf("/mse/%s/ws", code)),
		WebRTC: fmt.Sprintf("%s/webrtc/%s/whep", baseURL, code),
	}
}

// wsURL swaps a http(s):// base for ws(s):// — MSE is served over a
// websocket, not plain HTTP.
func wsURL(baseURL, path string) string {
	scheme := "ws"
	rest := baseURL
	switch {
	case len(baseURL) >= 8 && baseURL[:8] == "https://":
		scheme = "wss"
		rest = baseURL[8:]
	case len(baseURL) >= 7 && baseURL[:7] == "http://":
		scheme = "ws"
		rest = baseURL[7:]
	}
	return fmt.Sprintf("%s://%s%s", scheme, rest, path)
}
