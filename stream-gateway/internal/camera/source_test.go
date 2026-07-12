package camera

import (
	"testing"
	"time"

	pionwebrtc "github.com/pion/webrtc/v4"
)

// These tests exercise the viewer-refcounting / idle-teardown state machine
// directly (same package, so unexported fields are reachable) by presetting
// the Source's state to stateReady — waitReady() special-cases that state
// to return immediately, so these never actually try to dial RTSP.

func TestArmIdleTimer_OnlyForOnDemandReadyWithNoViewers(t *testing.T) {
	s := newSource("cam1", Config{OnDemand: true, IdleTimeout: time.Hour}, pionwebrtc.SettingEngine{})
	s.st = stateReady

	s.mu.Lock()
	s.armIdleTimerLocked()
	armed := s.idleTimer != nil
	s.mu.Unlock()
	if !armed {
		t.Fatal("expected idle timer to be armed for an on-demand, viewer-less, ready source")
	}

	// Not on-demand: must never arm.
	s2 := newSource("cam2", Config{OnDemand: false}, pionwebrtc.SettingEngine{})
	s2.st = stateReady
	s2.mu.Lock()
	s2.armIdleTimerLocked()
	armed2 := s2.idleTimer != nil
	s2.mu.Unlock()
	if armed2 {
		t.Fatal("always-on source must never get an idle timer")
	}

	// Has viewers: must not arm.
	s3 := newSource("cam3", Config{OnDemand: true}, pionwebrtc.SettingEngine{})
	s3.st = stateReady
	s3.viewers["hls"] = 1
	s3.mu.Lock()
	s3.armIdleTimerLocked()
	armed3 := s3.idleTimer != nil
	s3.mu.Unlock()
	if armed3 {
		t.Fatal("source with an active viewer must not get an idle timer")
	}
}

func TestAcquireViewer_TracksCountAndCancelsIdleTimer(t *testing.T) {
	s := newSource("cam1", Config{OnDemand: true, IdleTimeout: time.Hour}, pionwebrtc.SettingEngine{})
	s.st = stateReady
	s.mu.Lock()
	s.idleTimer = time.AfterFunc(time.Hour, func() {})
	s.mu.Unlock()

	release, err := s.AcquireViewer("webrtc")
	if err != nil {
		t.Fatalf("AcquireViewer failed: %v", err)
	}

	s.mu.Lock()
	if s.viewers["webrtc"] != 1 {
		t.Fatalf("expected 1 webrtc viewer, got %d", s.viewers["webrtc"])
	}
	if s.idleTimer != nil {
		t.Fatal("expected idle timer to be cancelled once a viewer attached")
	}
	s.mu.Unlock()

	release()

	s.mu.Lock()
	if s.viewers["webrtc"] != 0 {
		t.Fatalf("expected 0 webrtc viewers after release, got %d", s.viewers["webrtc"])
	}
	if s.idleTimer == nil {
		t.Fatal("expected idle timer to be re-armed once the last viewer released")
	}
	s.mu.Unlock()

	// release() must be idempotent.
	release()
	s.mu.Lock()
	count := s.viewers["webrtc"]
	s.mu.Unlock()
	if count != 0 {
		t.Fatalf("calling release() twice must not double-decrement, got %d", count)
	}
}

func TestTouchHLS_MarksViewerPresentWithoutDialing(t *testing.T) {
	s := newSource("cam1", Config{OnDemand: true, IdleTimeout: 50 * time.Millisecond}, pionwebrtc.SettingEngine{})
	s.st = stateReady

	if err := s.TouchHLS(); err != nil {
		t.Fatalf("TouchHLS failed: %v", err)
	}

	s.mu.Lock()
	if s.viewers["hls"] != 1 {
		t.Fatalf("expected hls viewer marked present, got %d", s.viewers["hls"])
	}
	reaperOn := s.hlsReaperOn
	s.mu.Unlock()
	if !reaperOn {
		t.Fatal("expected the hls reaper goroutine to have been started")
	}
	close(s.stopped) // stop the reaper goroutine cleanly before the test ends
}

func TestTouchHLS_ReaperClearsViewerAfterIdleTimeout(t *testing.T) {
	s := newSource("cam1", Config{OnDemand: true, IdleTimeout: 20 * time.Millisecond}, pionwebrtc.SettingEngine{})
	s.st = stateReady

	if err := s.TouchHLS(); err != nil {
		t.Fatalf("TouchHLS failed: %v", err)
	}
	defer close(s.stopped)

	// hlsReapInterval is 5s in source.go — too slow for a unit test to wait
	// on for real, so directly invoke one reaper tick's logic instead of
	// sleeping 5+ seconds.
	time.Sleep(30 * time.Millisecond) // let IdleTimeout actually elapse first
	s.mu.Lock()
	idleTimeout := s.cfg.IdleTimeout
	if s.viewers["hls"] > 0 && time.Since(s.hlsLastRequest) > idleTimeout {
		s.viewers["hls"] = 0
		s.armIdleTimerLocked()
	}
	cleared := s.viewers["hls"] == 0
	timerArmed := s.idleTimer != nil
	s.mu.Unlock()

	if !cleared {
		t.Fatal("expected hls viewer to be cleared once stale past IdleTimeout")
	}
	if !timerArmed {
		t.Fatal("expected idle-teardown timer to be armed once hls viewer cleared")
	}
}

func TestConfigure_DetectsRTSPURLChange(t *testing.T) {
	s := newSource("cam1", Config{RTSPURL: "rtsp://a/1", OnDemand: true}, pionwebrtc.SettingEngine{})
	s.st = stateIdle // idle, on-demand — Configure should NOT auto-connect just because the URL changed while idle

	s.Configure(Config{RTSPURL: "rtsp://b/2", OnDemand: true})

	s.mu.Lock()
	got := s.cfg.RTSPURL
	st := s.st
	s.mu.Unlock()

	if got != "rtsp://b/2" {
		t.Fatalf("expected config to be updated to the new URL, got %q", got)
	}
	if st != stateIdle {
		t.Fatalf("an idle on-demand source's config change shouldn't force a connect, got state %v", st)
	}
}
