// Package mse builds fMP4 (init segment once, one small fragment per
// finalized sample) for one camera and fans it out over a websocket to
// however many browsers are watching via MediaSource Extensions. Unlike
// HLS (pull-based; gohlslib owns segmenting/timing internally), this is
// push-based — every finalized sample becomes its own fragment immediately,
// for the lowest latency a WS transport can offer. This is the one piece
// with no ready-made muxer to call (see the plan's known limitation) —
// built directly on mediacommon's low-level fmp4 primitives, the same ones
// gohlslib itself uses internally.
package mse

import (
	"net/http"
	"sync"

	"github.com/bluenviron/mediacommon/v2/pkg/formats/fmp4"
	"github.com/bluenviron/mediacommon/v2/pkg/formats/fmp4/seekablebuffer"
	"github.com/bluenviron/mediacommon/v2/pkg/formats/mp4/codecs"
	"github.com/gorilla/websocket"

	"stream-gateway/internal/codecparams"
)

var upgrader = websocket.Upgrader{
	// LAN-only deployment, no auth anywhere else in this stack either —
	// matches Triton/HLS/the management API's own posture.
	CheckOrigin: func(_ *http.Request) bool { return true },
}

type pendingSample struct {
	pts    int64
	sample *fmp4.Sample
}

// Sink is one camera's fMP4-over-websocket writer + client fan-out.
type Sink struct {
	videoTrackID int
	videoCodec   string // "h264" | "h265" | ""
	audioTrackID int
	audioCodec   string // "mpeg4audio" | "opus" | ""
	initBytes    []byte

	mu           sync.Mutex
	seq          uint32
	pendingVideo *pendingSample
	pendingAudio *pendingSample
	clients      map[*websocket.Conn]chan []byte
	closed       bool
}

// NewSink builds the fMP4 init segment for the given codec set. Mirrors
// hls.NewSink's contract: exactly one of VideoH264/VideoH265 must be set;
// audio params may both be nil.
func NewSink(p codecparams.Set) (*Sink, error) {
	s := &Sink{clients: make(map[*websocket.Conn]chan []byte)}
	init := &fmp4.Init{}
	nextID := 1

	switch {
	case p.VideoH264 != nil:
		init.Tracks = append(init.Tracks, &fmp4.InitTrack{
			ID: nextID, TimeScale: uint32(p.VideoH264.ClockRate),
			Codec: &codecs.H264{SPS: p.VideoH264.SPS, PPS: p.VideoH264.PPS},
		})
		s.videoTrackID, s.videoCodec = nextID, "h264"
		nextID++
	case p.VideoH265 != nil:
		init.Tracks = append(init.Tracks, &fmp4.InitTrack{
			ID: nextID, TimeScale: uint32(p.VideoH265.ClockRate),
			Codec: &codecs.H265{VPS: p.VideoH265.VPS, SPS: p.VideoH265.SPS, PPS: p.VideoH265.PPS},
		})
		s.videoTrackID, s.videoCodec = nextID, "h265"
		nextID++
	}

	switch {
	case p.AudioMPEG4 != nil:
		init.Tracks = append(init.Tracks, &fmp4.InitTrack{
			ID: nextID, TimeScale: uint32(p.AudioMPEG4.ClockRate),
			Codec: &codecs.MPEG4Audio{Config: p.AudioMPEG4.Config},
		})
		s.audioTrackID, s.audioCodec = nextID, "mpeg4audio"
	case p.AudioOpus != nil:
		init.Tracks = append(init.Tracks, &fmp4.InitTrack{
			ID: nextID, TimeScale: uint32(p.AudioOpus.ClockRate),
			Codec: &codecs.Opus{ChannelCount: p.AudioOpus.ChannelCount},
		})
		s.audioTrackID, s.audioCodec = nextID, "opus"
	}

	var buf seekablebuffer.Buffer
	if err := init.Marshal(&buf); err != nil {
		return nil, err
	}
	s.initBytes = buf.Bytes()

	return s, nil
}

func (s *Sink) WriteH264(pts int64, au [][]byte) error {
	if s.videoCodec != "h264" {
		return nil
	}
	sample := &fmp4.Sample{}
	if err := sample.FillH264(0, au); err != nil {
		return err
	}
	return s.pushVideo(pts, sample)
}

func (s *Sink) WriteH265(pts int64, au [][]byte) error {
	if s.videoCodec != "h265" {
		return nil
	}
	sample := &fmp4.Sample{}
	if err := sample.FillH265(0, au); err != nil {
		return err
	}
	return s.pushVideo(pts, sample)
}

// WriteMPEG4Audio/WriteOpus: audio samples need no AVCC wrapping (that's
// an H264/H265-specific NAL-unit concern) — the raw frame/packet bytes are
// the fMP4 sample payload directly.
func (s *Sink) WriteMPEG4Audio(pts int64, aus [][]byte) error {
	if s.audioCodec != "mpeg4audio" {
		return nil
	}
	for _, au := range aus {
		if err := s.pushAudio(pts, &fmp4.Sample{Payload: au}); err != nil {
			return err
		}
	}
	return nil
}

func (s *Sink) WriteOpus(pts int64, packets [][]byte) error {
	if s.audioCodec != "opus" {
		return nil
	}
	for _, p := range packets {
		if err := s.pushAudio(pts, &fmp4.Sample{Payload: p}); err != nil {
			return err
		}
	}
	return nil
}

func (s *Sink) pushVideo(pts int64, sample *fmp4.Sample) error {
	return s.push(&s.pendingVideo, s.videoTrackID, pts, sample)
}

func (s *Sink) pushAudio(pts int64, sample *fmp4.Sample) error {
	return s.push(&s.pendingAudio, s.audioTrackID, pts, sample)
}

// push finalizes the PREVIOUS pending sample for this track — its duration
// is only knowable once the next sample's PTS arrives — and emits a
// one-sample fragment for it, then stores the new sample as pending.
func (s *Sink) push(pending **pendingSample, trackID int, pts int64, sample *fmp4.Sample) error {
	s.mu.Lock()
	prev := *pending
	*pending = &pendingSample{pts: pts, sample: sample}
	s.mu.Unlock()

	if prev == nil {
		return nil // first sample on this track — nothing to finalize yet
	}
	duration := pts - prev.pts
	if duration <= 0 {
		return nil // out-of-order/duplicate timestamp — drop rather than corrupt the fragment
	}
	prev.sample.Duration = uint32(duration)

	return s.emitFragment(trackID, prev.sample)
}

func (s *Sink) emitFragment(trackID int, sample *fmp4.Sample) error {
	s.mu.Lock()
	s.seq++
	seq := s.seq
	s.mu.Unlock()

	part := fmp4.Part{
		SequenceNumber: seq,
		Tracks: []*fmp4.PartTrack{
			{ID: trackID, Samples: []*fmp4.Sample{sample}},
		},
	}
	var buf seekablebuffer.Buffer
	if err := part.Marshal(&buf); err != nil {
		return err
	}
	s.broadcast(buf.Bytes())
	return nil
}

// Handler upgrades to a websocket, sends the init segment once, then
// streams every subsequent fragment to this one client until it
// disconnects or the Sink is Close()d.
func (s *Sink) Handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}

		ch := make(chan []byte, 32)
		s.mu.Lock()
		if s.closed {
			s.mu.Unlock()
			conn.Close()
			return
		}
		s.clients[conn] = ch
		initBytes := s.initBytes
		s.mu.Unlock()

		if err := conn.WriteMessage(websocket.BinaryMessage, initBytes); err != nil {
			s.removeClient(conn)
			return
		}

		// Dedicated reader goroutine solely to detect client disconnect
		// (gorilla/websocket requires at most one reader; we never expect
		// incoming messages from an MSE viewer).
		go func() {
			for {
				if _, _, err := conn.NextReader(); err != nil {
					s.removeClient(conn)
					return
				}
			}
		}()

		for frag := range ch {
			if err := conn.WriteMessage(websocket.BinaryMessage, frag); err != nil {
				s.removeClient(conn)
				return
			}
		}
	}
}

func (s *Sink) removeClient(conn *websocket.Conn) {
	s.mu.Lock()
	ch, ok := s.clients[conn]
	if ok {
		delete(s.clients, conn)
	}
	s.mu.Unlock()
	if ok {
		close(ch)
	}
	conn.Close()
}

func (s *Sink) broadcast(frag []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, ch := range s.clients {
		select {
		case ch <- frag:
		default:
			// Slow client: drop this fragment for it rather than block the
			// whole camera's write path on one lagging viewer.
		}
	}
}

func (s *Sink) Close() {
	s.mu.Lock()
	s.closed = true
	conns := make([]*websocket.Conn, 0, len(s.clients))
	for conn := range s.clients {
		conns = append(conns, conn)
	}
	s.mu.Unlock()
	for _, conn := range conns {
		s.removeClient(conn)
	}
}
