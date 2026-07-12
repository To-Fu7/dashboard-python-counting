package camera

import (
	"testing"
	"time"

	pionwebrtc "github.com/pion/webrtc/v4"
)

// Regression test: a brand-new always-on camera must start connecting
// immediately on registration, not just on a later Configure() call (which
// only fires for an *existing* source — a fresh source has no prior state
// to compare against to notice "just became always-on").
func TestUpsert_NewAlwaysOnSource_StartsConnectingImmediately(t *testing.T) {
	mgr := NewManager(pionwebrtc.SettingEngine{})
	// Bogus URL: the connect attempt will fail quickly, but that's fine —
	// this only checks that a connect attempt was *started* at all
	// (state leaves stateIdle), not that it succeeds.
	src := mgr.Upsert("cam1", Config{RTSPURL: "rtsp://127.0.0.1:1/nonexistent", OnDemand: false})

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		src.mu.Lock()
		st := src.st
		src.mu.Unlock()
		if st != stateIdle {
			return // success — it left idle (connecting, then presumably error)
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("a new always-on camera never left stateIdle — Upsert must call ensureConnected for new always-on sources")
}

// On-demand sources must NOT auto-connect on registration.
func TestUpsert_NewOnDemandSource_StaysIdleUntilViewer(t *testing.T) {
	mgr := NewManager(pionwebrtc.SettingEngine{})
	src := mgr.Upsert("cam1", Config{RTSPURL: "rtsp://127.0.0.1:1/nonexistent", OnDemand: true})

	time.Sleep(100 * time.Millisecond)
	src.mu.Lock()
	st := src.st
	src.mu.Unlock()
	if st != stateIdle {
		t.Fatalf("expected an on-demand camera to stay idle until a viewer attaches, got state %v", st)
	}
}
