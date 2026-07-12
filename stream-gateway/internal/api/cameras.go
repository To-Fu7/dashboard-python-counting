package api

import (
	"encoding/json"
	"net/http"
	"time"

	"stream-gateway/internal/camera"
	"stream-gateway/internal/urls"
)

type upsertCameraRequest struct {
	RTSPURL            string `json:"rtspUrl"`
	OnDemand           bool   `json:"onDemand"`
	IncludeAudio       bool   `json:"includeAudio"`
	IdleTimeoutSeconds int    `json:"idleTimeoutSeconds"`
}

type cameraResponse struct {
	Code  string    `json:"code"`
	State string    `json:"state"`
	URLs  urls.Set  `json:"urls"`
}

type cameraStatusResponse struct {
	Code     string         `json:"code"`
	State    string         `json:"state"`
	OnDemand bool           `json:"onDemand"`
	Viewers  map[string]int `json:"viewers"`
	LastErr  string         `json:"lastError,omitempty"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func (h *handler) upsertCamera(w http.ResponseWriter, r *http.Request) {
	code := r.PathValue("code")
	if code == "" {
		writeError(w, http.StatusBadRequest, "missing camera code")
		return
	}

	var req upsertCameraRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body: "+err.Error())
		return
	}
	if req.RTSPURL == "" {
		writeError(w, http.StatusBadRequest, "rtspUrl is required")
		return
	}

	cfg := camera.Config{
		RTSPURL:      req.RTSPURL,
		OnDemand:     req.OnDemand,
		IncludeAudio: req.IncludeAudio,
	}
	if req.IdleTimeoutSeconds > 0 {
		cfg.IdleTimeout = time.Duration(req.IdleTimeoutSeconds) * time.Second
	}

	src := h.mgr.Upsert(code, cfg)
	snap := src.Snapshot()

	writeJSON(w, http.StatusOK, cameraResponse{
		Code:  code,
		State: snap.State,
		URLs:  urls.Build(h.cfg.PublicBaseURL, code),
	})
}

func (h *handler) removeCamera(w http.ResponseWriter, r *http.Request) {
	code := r.PathValue("code")
	h.mgr.Remove(code)
	w.WriteHeader(http.StatusNoContent)
}

func (h *handler) listCameras(w http.ResponseWriter, _ *http.Request) {
	statuses := h.mgr.List()
	out := make([]cameraStatusResponse, 0, len(statuses))
	for _, s := range statuses {
		out = append(out, cameraStatusResponse{
			Code: s.Code, State: s.State, OnDemand: s.OnDemand, Viewers: s.Viewers, LastErr: s.LastErr,
		})
	}
	writeJSON(w, http.StatusOK, map[string]any{"cameras": out})
}

func (h *handler) cameraURLs(w http.ResponseWriter, r *http.Request) {
	code := r.PathValue("code")
	if _, ok := h.mgr.Get(code); !ok {
		writeError(w, http.StatusNotFound, "camera not registered")
		return
	}
	writeJSON(w, http.StatusOK, urls.Build(h.cfg.PublicBaseURL, code))
}
