package camera

import (
	"fmt"
	"sync"

	pionwebrtc "github.com/pion/webrtc/v4"
)

// Manager is the registry of all cameras this process knows about, keyed by
// device code. The dashboard is the source of truth for camera config —
// this only holds an in-memory copy, re-pushed via Upsert whenever the
// dashboard's own per-device settings change.
type Manager struct {
	mu            sync.RWMutex
	sources       map[string]*Source
	settingEngine pionwebrtc.SettingEngine
}

// NewManager builds the camera registry. settingEngine is the process-wide
// pion SettingEngine (holds the fixed WebRTC UDP mux — see main.go) shared
// by every camera's WHEP sessions.
func NewManager(settingEngine pionwebrtc.SettingEngine) *Manager {
	return &Manager{sources: make(map[string]*Source), settingEngine: settingEngine}
}

// Upsert registers a new camera or reconfigures an existing one.
func (m *Manager) Upsert(code string, cfg Config) *Source {
	m.mu.Lock()
	src, exists := m.sources[code]
	if !exists {
		src = newSource(code, cfg, m.settingEngine)
		m.sources[code] = src
	}
	m.mu.Unlock()

	if exists {
		src.Configure(cfg)
	} else if !cfg.OnDemand {
		// A brand-new source has no prior state for Configure() to compare
		// against, so it can't detect "just became always-on" — a new
		// always-on registration must start connecting immediately here.
		src.ensureConnected()
	}
	return src
}

// Remove tears down and unregisters a camera. No-op if it doesn't exist.
func (m *Manager) Remove(code string) {
	m.mu.Lock()
	src, exists := m.sources[code]
	if exists {
		delete(m.sources, code)
	}
	m.mu.Unlock()

	if exists {
		src.Remove()
	}
}

// Get returns the Source for a camera code, or (nil, false) if it isn't registered.
func (m *Manager) Get(code string) (*Source, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	src, ok := m.sources[code]
	return src, ok
}

// MustGet is a convenience for handlers that have already validated the
// camera exists (e.g. via Get in a preceding check).
func (m *Manager) MustGet(code string) (*Source, error) {
	src, ok := m.Get(code)
	if !ok {
		return nil, fmt.Errorf("camera %q is not registered", code)
	}
	return src, nil
}

// List returns a status snapshot of every registered camera.
func (m *Manager) List() []Status {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]Status, 0, len(m.sources))
	for _, src := range m.sources {
		out = append(out, src.Snapshot())
	}
	return out
}
