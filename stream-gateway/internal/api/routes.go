// Package api implements stream-gateway's management REST API
// (PUT/DELETE/GET /api/v1/cameras...) — the surface the dashboard calls to
// register cameras and fetch their playback URLs. No auth, matching every
// other service in this stack (Triton included) — LAN-only deployment.
package api

import (
	"net/http"

	"stream-gateway/internal/camera"
	"stream-gateway/internal/config"
)

// Mount registers the management API routes on mux.
func Mount(mux *http.ServeMux, mgr *camera.Manager, cfg config.Config) {
	h := &handler{mgr: mgr, cfg: cfg}

	mux.HandleFunc("GET /api/v1/healthz", h.healthz)
	mux.HandleFunc("GET /api/v1/cameras", h.listCameras)
	mux.HandleFunc("PUT /api/v1/cameras/{code}", h.upsertCamera)
	mux.HandleFunc("DELETE /api/v1/cameras/{code}", h.removeCamera)
	mux.HandleFunc("GET /api/v1/cameras/{code}/urls", h.cameraURLs)
}

type handler struct {
	mgr *camera.Manager
	cfg config.Config
}

func (h *handler) healthz(w http.ResponseWriter, _ *http.Request) {
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok"))
}
