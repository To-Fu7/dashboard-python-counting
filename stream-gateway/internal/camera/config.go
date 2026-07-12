package camera

import "time"

// Config is one camera's stream registration, upserted via
// PUT /api/v1/cameras/{code}. The dashboard is the source of truth for this
// data (per-device .env_<CODE> fields) — stream-gateway only holds it
// in-memory, re-pushed by the dashboard on every relevant device save.
//
// A device's optional substream (SUBSTREAM_URL) is not modeled here — it's
// just registered as its own independent code ("<device code>_sub") by the
// dashboard, with its own PUT call. stream-gateway has no notion of "main
// vs sub"; that convention lives entirely on the dashboard side.
type Config struct {
	// RTSPURL is this camera's RTSP source.
	RTSPURL string

	// OnDemand: true connects to the RTSP source only when a viewer is
	// attached (any protocol), tearing down after IdleTimeout once the last
	// viewer leaves. false keeps the source connected from registration
	// onward, reconnecting with backoff on error regardless of viewers.
	OnDemand bool

	// IncludeAudio passes through the RTSP audio track (if present) to the
	// web player. NOTE: HLS/MSE can only carry AAC/Opus audio (no G.711
	// muxer available in the underlying libraries or in browser MSE) —
	// G.711 sources only get audio on the WebRTC path. This flag doesn't
	// change that; it's a hint the source config is passed through.
	IncludeAudio bool

	// IdleTimeout overrides config.Config.DefaultIdleTimeout for this
	// camera specifically. Zero means "use the process default".
	IdleTimeout time.Duration
}
