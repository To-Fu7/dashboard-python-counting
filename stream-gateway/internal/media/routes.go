// Package media mounts the browser-facing playback endpoints (HLS, MSE,
// WebRTC/WHEP) — the layer that bridges camera.Manager (connection
// lifecycle, viewer refcounting) with each protocol's own handler/sink.
// This can't live inside package camera (protocol packages like hls/mse/
// webrtc are imported BY camera, not the reverse) or inside those packages
// themselves (none of them know Manager exists, by design — each only
// knows about one Sink at a time).
package media

import (
	"net/http"
	"time"

	"stream-gateway/internal/camera"
	"stream-gateway/internal/webrtc"
)

// Mount registers the media-serving routes on mux.
func Mount(mux *http.ServeMux, mgr *camera.Manager) {
	mux.HandleFunc("GET /hls/{code}/{rest...}", handleHLS(mgr))
	mux.HandleFunc("GET /mse/{code}/ws", handleMSE(mgr))
	mux.HandleFunc("POST /webrtc/{code}/whep", handleWebRTCOffer(mgr))
	mux.HandleFunc("DELETE /webrtc/{code}/whep/{sessionId}", handleWebRTCTeardown(mgr))
	mux.HandleFunc("OPTIONS /webrtc/{code}/whep", handleWebRTCOffer(mgr)) // CORS preflight
}

func handleHLS(mgr *camera.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		code := r.PathValue("code")
		src, ok := mgr.Get(code)
		if !ok {
			http.Error(w, "camera not registered", http.StatusNotFound)
			return
		}

		// TouchHLS (not AcquireViewer — HLS is pull-based, see source.go)
		// connects an on-demand camera on first request and blocks until
		// ready, so the very first playlist GET after registration doesn't
		// 404 before the RTSP handshake finishes.
		if err := src.TouchHLS(); err != nil {
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}

		handler, err := src.HLSHandler()
		if err != nil {
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}

		// gohlslib's own Handle can legitimately block for a while on the
		// very first request for a camera (waiting for enough data to
		// produce the master playlist) — found live-testing against a real
		// camera whose first segment took long enough that the idle
		// reaper's "no request seen recently" check (TouchHLS only
		// timestamps at request *start*) misread a single still-in-flight
		// request as "no viewers" and tore the connection down underneath
		// it. Keep re-touching every few seconds for as long as this
		// specific request is still being handled.
		done := make(chan struct{})
		defer close(done)
		go func() {
			ticker := time.NewTicker(5 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-done:
					return
				case <-ticker.C:
					_ = src.TouchHLS()
				}
			}
		}()

		handler(w, r)
	}
}

func handleMSE(mgr *camera.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		code := r.PathValue("code")
		src, ok := mgr.Get(code)
		if !ok {
			http.Error(w, "camera not registered", http.StatusNotFound)
			return
		}

		release, err := src.AcquireViewer("mse")
		if err != nil {
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}
		// MSE is a long-lived websocket — this handler call blocks for the
		// whole viewer session (see mse.Sink.Handler), so releasing right
		// after it returns correctly marks "viewer gone" for the idle timer.
		defer release()

		handler, err := src.MSEHandler()
		if err != nil {
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}
		handler(w, r)
	}
}

func handleWebRTCOffer(mgr *camera.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			w.Header().Set("Access-Control-Allow-Origin", "*")
			w.Header().Set("Access-Control-Allow-Methods", "POST, DELETE")
			w.Header().Set("Access-Control-Allow-Headers", "*")
			return
		}

		code := r.PathValue("code")
		src, ok := mgr.Get(code)
		if !ok {
			http.Error(w, "camera not registered", http.StatusNotFound)
			return
		}

		release, err := src.AcquireViewer("webrtc")
		if err != nil {
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}

		sink, settingEngine, err := src.WebRTCSink()
		if err != nil {
			release()
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}

		// release is NOT deferred here — the viewer's actual lifetime is the
		// PeerConnection's, which outlives this request/response. HandleOffer
		// wires release into the session's ICE-state-change callback instead.
		webrtc.HandleOffer(sink, settingEngine, release, w, r)
	}
}

func handleWebRTCTeardown(mgr *camera.Manager) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		code := r.PathValue("code")
		src, ok := mgr.Get(code)
		if !ok {
			http.Error(w, "camera not registered", http.StatusNotFound)
			return
		}

		sink, _, err := src.WebRTCSink()
		if err != nil {
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}

		// closeSession's pc.Close() drives the same OnICEConnectionStateChange
		// -> release() path wired up in handleWebRTCOffer, so viewer-count
		// bookkeeping stays correct here too.
		webrtc.HandleTeardown(sink, w, r)
	}
}
