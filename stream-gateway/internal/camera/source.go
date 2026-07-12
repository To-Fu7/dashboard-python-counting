package camera

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/bluenviron/gortsplib/v5"
	"github.com/bluenviron/gortsplib/v5/pkg/base"
	pionwebrtc "github.com/pion/webrtc/v4"

	"stream-gateway/internal/hls"
	"stream-gateway/internal/mse"
	"stream-gateway/internal/webrtc"
)

// sinkBundle groups the three per-camera sinks built together on every
// connect and torn down together on every disconnect.
type sinkBundle struct {
	hls    *hls.Sink
	mse    *mse.Sink
	webrtc *webrtc.Sink
}

func (b *sinkBundle) Close() {
	if b == nil {
		return
	}
	b.hls.Close()
	b.mse.Close()
	b.webrtc.Close()
}

type state int

const (
	stateIdle state = iota
	stateConnecting
	stateReady
	stateError
)

func (s state) String() string {
	switch s {
	case stateIdle:
		return "idle"
	case stateConnecting:
		return "connecting"
	case stateReady:
		return "ready"
	case stateError:
		return "error"
	default:
		return "unknown"
	}
}

const (
	connectTimeout      = 10 * time.Second
	defaultIdleGrace    = 30 * time.Second
	reconnectBackoffMin = 1 * time.Second
	reconnectBackoffMax = 30 * time.Second
	hlsReapInterval     = 5 * time.Second
)

// Source is the runtime state for one registered camera: connection
// lifecycle (on-demand connect + idle teardown, or always-on with backoff
// reconnect), viewer refcounting per protocol ("hls" today; "mse"/"webrtc"
// once Phase 2 lands), and the RTSP->HLS bridge itself.
type Source struct {
	code string

	mu         sync.Mutex
	cfg        Config
	st         state
	viewers    map[string]int
	lastErr    error
	generation uint64 // bumped on every (re)connect attempt; guards stale timers/goroutines from a superseded attempt
	cancel     context.CancelFunc
	readyCh    chan struct{}
	idleTimer  *time.Timer
	sinks      *sinkBundle

	// Shared process-wide (holds the fixed UDP mux — see config.go/main.go)
	// so every camera's WebRTC sessions use the same published port.
	settingEngine pionwebrtc.SettingEngine

	// HLS is pull-based (playlist/segment GETs) — there's no connection to
	// hold open the way AcquireViewer's release func works for MSE/WebRTC.
	// TouchHLS records the last request time instead; hlsReaper (started on
	// the first touch) periodically checks it and clears "hls" from viewers
	// once it goes stale, feeding into the same idle-teardown path.
	hlsLastRequest time.Time
	hlsReaperOn    bool

	stopped chan struct{} // closed by shutdown() when this camera is fully removed
}

func newSource(code string, cfg Config, settingEngine pionwebrtc.SettingEngine) *Source {
	return &Source{
		code:          code,
		cfg:           cfg,
		st:            stateIdle,
		viewers:       make(map[string]int),
		readyCh:       make(chan struct{}),
		stopped:       make(chan struct{}),
		settingEngine: settingEngine,
	}
}

// Status is a point-in-time snapshot, for GET /api/v1/cameras.
type Status struct {
	Code     string
	State    string
	OnDemand bool
	Viewers  map[string]int
	LastErr  string
}

func (s *Source) Snapshot() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	viewers := make(map[string]int, len(s.viewers))
	for k, v := range s.viewers {
		viewers[k] = v
	}
	errStr := ""
	if s.lastErr != nil {
		errStr = s.lastErr.Error()
	}
	return Status{Code: s.code, State: s.st.String(), OnDemand: s.cfg.OnDemand, Viewers: viewers, LastErr: errStr}
}

// Configure upserts this source's config. If the RTSP URL or audio setting
// changed while connected/connecting, forces a reconnect; if the source was
// on-demand-and-idle and just became always-on, starts connecting right away.
func (s *Source) Configure(cfg Config) {
	s.mu.Lock()
	changed := s.cfg.RTSPURL != cfg.RTSPURL || s.cfg.IncludeAudio != cfg.IncludeAudio
	wasOnDemand := s.cfg.OnDemand
	wasIdle := s.st == stateIdle
	activeNow := s.st == stateReady || s.st == stateConnecting
	s.cfg = cfg
	s.mu.Unlock()

	if changed && activeNow {
		s.teardown("config changed")
	}
	if (changed && activeNow) || (wasOnDemand && !cfg.OnDemand && wasIdle) {
		s.ensureConnected()
	}
}

// Remove tears down any active connection and stops this Source's
// background reaper goroutine for good. Called by Manager right before
// deleting this Source from its registry — the Source must not be used
// again after this.
func (s *Source) Remove() {
	s.teardown("removed")
	close(s.stopped)
}

// AcquireViewer registers one viewer of the given protocol — for
// connection-held protocols (MSE, WebRTC; not implemented until Phase 2)
// where a release func naturally fires on disconnect. HLS doesn't use this
// (see TouchHLS below). Connects an on-demand source if this is the first
// viewer across any protocol, and blocks (up to connectTimeout) until the
// source is Ready or a connect error occurs. The returned release func must
// be called exactly once when the viewer disconnects.
func (s *Source) AcquireViewer(proto string) (release func(), err error) {
	s.mu.Lock()
	s.viewers[proto]++
	s.cancelIdleTimerLocked()
	needsConnect := s.totalViewers() == 1 && s.st == stateIdle
	s.mu.Unlock()

	if needsConnect {
		s.ensureConnected()
	}

	if waitErr := s.waitReady(); waitErr != nil {
		s.releaseViewer(proto)
		return nil, waitErr
	}

	var released bool
	var releaseMu sync.Mutex
	release = func() {
		releaseMu.Lock()
		defer releaseMu.Unlock()
		if released {
			return
		}
		released = true
		s.releaseViewer(proto)
	}
	return release, nil
}

// TouchHLS should be called by the HLS HTTP handler on every request — HLS
// is pull-based (playlist/segment GETs), so unlike AcquireViewer there's no
// connection whose closure would tell us a viewer left. The first touch
// connects an on-demand source (same as AcquireViewer) and starts a
// background reaper that clears the "hls" viewer once requests stop
// arriving for cfg.IdleTimeout, feeding into the same idle-teardown path.
func (s *Source) TouchHLS() error {
	s.mu.Lock()
	first := s.viewers["hls"] == 0
	s.viewers["hls"] = 1
	s.hlsLastRequest = time.Now()
	s.cancelIdleTimerLocked()
	needsConnect := first && s.st == stateIdle
	startReaper := first && !s.hlsReaperOn
	if startReaper {
		s.hlsReaperOn = true
	}
	s.mu.Unlock()

	if startReaper {
		go s.hlsReaper()
	}
	if needsConnect {
		s.ensureConnected()
	}
	return s.waitReady()
}

func (s *Source) hlsReaper() {
	ticker := time.NewTicker(hlsReapInterval)
	defer ticker.Stop()
	for {
		select {
		case <-s.stopped:
			return
		case <-ticker.C:
			s.mu.Lock()
			idleTimeout := s.cfg.IdleTimeout
			if idleTimeout <= 0 {
				idleTimeout = defaultIdleGrace
			}
			if s.viewers["hls"] > 0 && time.Since(s.hlsLastRequest) > idleTimeout {
				s.viewers["hls"] = 0
				s.armIdleTimerLocked()
			}
			active := s.viewers["hls"] > 0
			if !active {
				s.hlsReaperOn = false
			}
			s.mu.Unlock()
			if !active {
				return // TouchHLS restarts this if requests resume later
			}
		}
	}
}

// HLSHandler returns the current HLS handler. Callers must TouchHLS first —
// this only reads whatever sink is active right now.
func (s *Source) HLSHandler() (http.HandlerFunc, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sinks == nil {
		return nil, errors.New("camera not connected")
	}
	return s.sinks.hls.Handler(), nil
}

// MSEHandler returns the current MSE (websocket) handler. Callers must
// AcquireViewer("mse") first.
func (s *Source) MSEHandler() (http.HandlerFunc, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sinks == nil {
		return nil, errors.New("camera not connected")
	}
	return s.sinks.mse.Handler(), nil
}

// WebRTCSink returns the current WebRTC sink (for HandleOffer/HandleTeardown)
// plus the shared SettingEngine. Callers must AcquireViewer("webrtc") first.
func (s *Source) WebRTCSink() (*webrtc.Sink, pionwebrtc.SettingEngine, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sinks == nil {
		return nil, pionwebrtc.SettingEngine{}, errors.New("camera not connected")
	}
	return s.sinks.webrtc, s.settingEngine, nil
}

func (s *Source) releaseViewer(proto string) {
	s.mu.Lock()
	if s.viewers[proto] > 0 {
		s.viewers[proto]--
	}
	s.armIdleTimerLocked()
	s.mu.Unlock()
}

// cancelIdleTimerLocked must be called with s.mu held.
func (s *Source) cancelIdleTimerLocked() {
	if s.idleTimer != nil {
		s.idleTimer.Stop()
		s.idleTimer = nil
	}
}

// armIdleTimerLocked schedules teardown after the configured idle grace
// period if this is an on-demand, currently-Ready source with no viewers
// left across any protocol. Must be called with s.mu held.
func (s *Source) armIdleTimerLocked() {
	if s.totalViewers() > 0 || !s.cfg.OnDemand || s.st != stateReady {
		return
	}
	idleTimeout := s.cfg.IdleTimeout
	if idleTimeout <= 0 {
		idleTimeout = defaultIdleGrace
	}
	gen := s.generation
	s.cancelIdleTimerLocked()
	s.idleTimer = time.AfterFunc(idleTimeout, func() { s.onIdleTimeout(gen) })
}

func (s *Source) totalViewers() int {
	n := 0
	for _, c := range s.viewers {
		n += c
	}
	return n
}

func (s *Source) onIdleTimeout(gen uint64) {
	s.mu.Lock()
	stale := s.generation != gen || s.totalViewers() > 0
	s.mu.Unlock()
	if stale {
		return
	}
	s.teardown("idle timeout")
}

func (s *Source) waitReady() error {
	s.mu.Lock()
	ch := s.readyCh
	st := s.st
	s.mu.Unlock()

	if st == stateReady {
		return nil
	}

	select {
	case <-ch:
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.st != stateReady {
			if s.lastErr != nil {
				return s.lastErr
			}
			return fmt.Errorf("camera %q is not ready", s.code)
		}
		return nil
	case <-time.After(connectTimeout):
		return fmt.Errorf("timed out waiting for camera %q to connect", s.code)
	}
}

// ensureConnected starts a connect attempt if one isn't already running.
func (s *Source) ensureConnected() {
	s.mu.Lock()
	if s.st == stateConnecting || s.st == stateReady {
		s.mu.Unlock()
		return
	}
	s.st = stateConnecting
	s.generation++
	gen := s.generation
	ctx, cancel := context.WithCancel(context.Background())
	s.cancel = cancel
	s.mu.Unlock()

	go s.connectLoop(ctx, gen)
}

func (s *Source) teardown(reason string) {
	s.mu.Lock()
	if s.cancel != nil {
		s.cancel()
		s.cancel = nil
	}
	if s.idleTimer != nil {
		s.idleTimer.Stop()
		s.idleTimer = nil
	}
	sinks := s.sinks
	s.sinks = nil
	s.st = stateIdle
	s.generation++
	s.readyCh = make(chan struct{})
	s.mu.Unlock()

	sinks.Close()
	log.Printf("[%s] connection torn down (%s)", s.code, reason)
}

func (s *Source) fail(gen uint64, err error) {
	s.mu.Lock()
	if s.generation != gen {
		s.mu.Unlock()
		return
	}
	s.st = stateError
	s.lastErr = err
	close(s.readyCh)
	s.readyCh = make(chan struct{})
	s.mu.Unlock()
	log.Printf("[%s] connect error: %v", s.code, err)
}

func (s *Source) succeed(gen uint64, sinks *sinkBundle) bool {
	s.mu.Lock()
	if s.generation != gen {
		s.mu.Unlock()
		sinks.Close()
		return false
	}
	s.st = stateReady
	s.lastErr = nil
	s.sinks = sinks
	close(s.readyCh)
	s.readyCh = make(chan struct{})
	s.mu.Unlock()
	return true
}

// connectLoop runs (and, for always-on sources, retries with backoff) one
// RTSP connection for as long as ctx is alive. On-demand sources make a
// single attempt per ensureConnected() call — a failed attempt just leaves
// the source in stateError until the next AcquireViewer tries again.
func (s *Source) connectLoop(ctx context.Context, gen uint64) {
	backoff := reconnectBackoffMin
	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		sinks, waitErrCh, err := s.connectOnce(ctx)
		if err != nil {
			s.fail(gen, err)
			s.mu.Lock()
			onDemand := s.cfg.OnDemand
			s.mu.Unlock()
			if onDemand {
				return
			}
			if !sleepOrDone(ctx, backoff) {
				return
			}
			backoff = nextBackoff(backoff)
			continue
		}

		if !s.succeed(gen, sinks) {
			return // superseded by a newer connect attempt/teardown
		}
		backoff = reconnectBackoffMin

		select {
		case <-ctx.Done():
			return
		case waitErr := <-waitErrCh:
			log.Printf("[%s] RTSP connection ended: %v", s.code, waitErr)
			s.mu.Lock()
			stillCurrent := s.generation == gen
			onDemand := s.cfg.OnDemand
			s.mu.Unlock()
			if !stillCurrent {
				return
			}
			if onDemand {
				s.teardown("upstream disconnected")
				return
			}
			s.mu.Lock()
			s.st = stateConnecting
			s.mu.Unlock()
			if !sleepOrDone(ctx, backoff) {
				return
			}
			backoff = nextBackoff(backoff)
			continue
		}
	}
}

func sleepOrDone(ctx context.Context, d time.Duration) bool {
	select {
	case <-ctx.Done():
		return false
	case <-time.After(d):
		return true
	}
}

func nextBackoff(cur time.Duration) time.Duration {
	next := cur * 2
	if next > reconnectBackoffMax {
		return reconnectBackoffMax
	}
	return next
}

// connectOnce dials the RTSP source, negotiates the supported video/audio
// formats, builds the HLS/MSE/WebRTC sinks for them, and starts playback.
// The returned channel receives exactly one value when the connection ends
// (error or a clean close via ctx cancellation closing the client).
func (s *Source) connectOnce(ctx context.Context) (*sinkBundle, <-chan error, error) {
	s.mu.Lock()
	cfg := s.cfg
	s.mu.Unlock()

	u, err := base.ParseURL(cfg.RTSPURL)
	if err != nil {
		return nil, nil, fmt.Errorf("invalid RTSP URL: %w", err)
	}

	// TEMP DIAGNOSTIC: UDP transport ruled out — with Protocol=UDP, gortsplib
	// picks ephemeral container-internal ports for RTP/RTCP that are never
	// published in docker-compose, so even if the camera responded over UDP
	// the packets couldn't reach this container. Reverted to TCP-interleaved
	// (which needs no extra ports — data rides the same outbound TCP socket
	// this client already opened) while diagnosing why zero video packets
	// arrive over it despite SETUP/PLAY succeeding.
	protoTCP := gortsplib.ProtocolTCP
	client := &gortsplib.Client{
		Scheme:   u.Scheme,
		Host:     u.Host,
		Protocol: &protoTCP,
	}

	if err := client.Start(); err != nil {
		return nil, nil, fmt.Errorf("connect: %w", err)
	}

	desc, _, err := client.Describe(u)
	if err != nil {
		client.Close()
		return nil, nil, fmt.Errorf("describe: %w", err)
	}

	bridge, err := newRTSPBridge(client, desc, cfg.IncludeAudio)
	if err != nil {
		client.Close()
		return nil, nil, err
	}
	log.Printf("DEBUG [%s] SDP describe done, videoCodec=%s hasVideoParams(pre-Play)=%v", s.code, bridge.videoCodec, bridge.hasVideoParams())

	// attach() registers the RTP callbacks once, before Play() — with no
	// sinks yet. The callbacks still decode every packet (needed both to
	// advance the depacketizer's own state and to extract in-band
	// parameter sets — see bridge.updateParamsFromAU), they just drop the
	// result until setSinks() is called below. This must happen before
	// Play(), not after: gortsplib gives no thread-safety guarantee for
	// registering/changing a callback while packets are actively arriving.
	bridge.attach()

	if _, err := client.Play(nil); err != nil {
		client.Close()
		return nil, nil, fmt.Errorf("play: %w", err)
	}

	// Many real cameras (confirmed live against a production Hikvision-style
	// H265 stream) don't announce SPS/PPS/VPS in the SDP — they send them
	// in-band instead, which is legal but means we can't build the HLS/MSE
	// init segments immediately after SETUP the way a well-behaved camera
	// allows. Wait briefly for the first in-band parameter set to arrive
	// (a no-op wait — resolves on the first check — for cameras that did
	// announce them in the SDP).
	if !waitForVideoParams(ctx, bridge, connectTimeout) {
		client.Close()
		return nil, nil, fmt.Errorf(
			"timed out waiting for %s parameter sets — camera never sent them in-band or via SDP",
			bridge.videoCodec,
		)
	}

	params := bridge.trackParams()

	hlsSink, err := hls.NewSink(params)
	if err != nil {
		client.Close()
		return nil, nil, fmt.Errorf("hls sink: %w", err)
	}
	mseSink, err := mse.NewSink(params)
	if err != nil {
		hlsSink.Close()
		client.Close()
		return nil, nil, fmt.Errorf("mse sink: %w", err)
	}
	webrtcSink, err := webrtc.NewSink(params)
	if err != nil {
		hlsSink.Close()
		mseSink.Close()
		client.Close()
		return nil, nil, fmt.Errorf("webrtc sink: %w", err)
	}

	sinks := &sinkBundle{hls: hlsSink, mse: mseSink, webrtc: webrtcSink}
	bridge.setSinks([]sampleSink{hlsSink, mseSink}, []rtpSink{webrtcSink})

	waitErrCh := make(chan error, 1)
	go func() {
		waitErrCh <- client.Wait()
	}()
	go func() {
		<-ctx.Done()
		client.Close()
	}()

	return sinks, waitErrCh, nil
}

// waitForVideoParams polls bridge.hasVideoParams (populated by the priming
// RTP callbacks already running via bridge.attach()) until it's true or
// timeout elapses. Returns false on timeout or if ctx is cancelled first.
func waitForVideoParams(ctx context.Context, bridge *rtspBridge, timeout time.Duration) bool {
	if bridge.hasVideoParams() {
		return true
	}
	deadline := time.Now().Add(timeout)
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return false
		case <-ticker.C:
			if bridge.hasVideoParams() {
				return true
			}
		}
	}
	return false
}
