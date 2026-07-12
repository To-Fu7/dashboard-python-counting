// Package webrtc serves one camera's video (and, when the source audio is
// Opus, audio) as WebRTC via a minimal WHEP-shaped signaling endpoint
// (POST offer -> 201 + Location + answer SDP; DELETE to tear a viewer
// session down) — the standardized wire format go2rtc/mediamtx/RTSPtoWeb
// all use, not a custom protocol.
//
// Unlike HLS/MSE, WebRTC already speaks RTP natively, so this sink needs no
// depacketization at all: camera.rtspBridge forwards raw *rtp.Packet values
// straight into TrackLocalStaticRTP.WriteRTP.
//
// Scope for this version: video is H264 only (H265 WebRTC browser support
// is inconsistent enough not to bother yet — those sources still get
// HLS/MSE fine). Audio is Opus only — AAC has no WebRTC codec at all, and
// G711 is skipped here even though WebRTC could technically carry it,
// to keep the codec-selection logic in camera.rtspBridge single-purpose
// (one codec choice serves all three sinks; see codecparams.Set).
package webrtc

import (
	"sync"

	"github.com/google/uuid"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"

	"stream-gateway/internal/codecparams"
)

// Sink holds the persistent tracks one camera's RTP gets forwarded into,
// plus the registry of active WHEP viewer sessions (one PeerConnection per
// viewer, all subscribing to these same shared tracks).
type Sink struct {
	videoTrack *webrtc.TrackLocalStaticRTP
	audioTrack *webrtc.TrackLocalStaticRTP // nil if the source has no Opus audio
	hasVideo   bool

	mu       sync.Mutex
	sessions map[string]*webrtc.PeerConnection
}

// NewSink builds the shared tracks for one camera. Returns hasVideo=false
// (via Sink.HasVideo) if the codec set has no H264 video — WebRTC is simply
// unavailable for that camera in that case (caller should still register
// HLS/MSE, which support H265 too).
func NewSink(p codecparams.Set) (*Sink, error) {
	s := &Sink{sessions: make(map[string]*webrtc.PeerConnection)}

	if p.VideoH264 != nil {
		track, err := webrtc.NewTrackLocalStaticRTP(
			webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264},
			"video", "streamgw",
		)
		if err != nil {
			return nil, err
		}
		s.videoTrack = track
		s.hasVideo = true
	}

	if p.AudioOpus != nil {
		track, err := webrtc.NewTrackLocalStaticRTP(
			webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2},
			"audio", "streamgw",
		)
		if err != nil {
			return nil, err
		}
		s.audioTrack = track
	}

	return s, nil
}

func (s *Sink) HasVideo() bool { return s.hasVideo }

// WriteVideoRTP/WriteAudioRTP forward a raw RTP packet as-is — no
// depacketization, no re-encoding. A nil track (no compatible audio) is a
// silent no-op.
func (s *Sink) WriteVideoRTP(pkt *rtp.Packet) {
	if s.videoTrack != nil {
		_ = s.videoTrack.WriteRTP(pkt)
	}
}

func (s *Sink) WriteAudioRTP(pkt *rtp.Packet) {
	if s.audioTrack != nil {
		_ = s.audioTrack.WriteRTP(pkt)
	}
}

// addSession registers a new viewer's PeerConnection and returns its
// session ID (used in the WHEP Location header / DELETE URL).
func (s *Sink) addSession(pc *webrtc.PeerConnection) string {
	id := uuid.NewString()
	s.mu.Lock()
	s.sessions[id] = pc
	s.mu.Unlock()
	return id
}

// closeSession tears down one viewer session (DELETE /webrtc/{code}/whep/{id}).
// Returns false if the session doesn't exist (already closed, or never did).
func (s *Sink) closeSession(id string) bool {
	s.mu.Lock()
	pc, ok := s.sessions[id]
	if ok {
		delete(s.sessions, id)
	}
	s.mu.Unlock()
	if ok {
		_ = pc.Close()
	}
	return ok
}

// Close tears down every active viewer session for this camera (called
// when the camera itself disconnects/is removed).
func (s *Sink) Close() {
	s.mu.Lock()
	pcs := make([]*webrtc.PeerConnection, 0, len(s.sessions))
	for _, pc := range s.sessions {
		pcs = append(pcs, pc)
	}
	s.sessions = make(map[string]*webrtc.PeerConnection)
	s.mu.Unlock()
	for _, pc := range pcs {
		_ = pc.Close()
	}
}
