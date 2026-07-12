// Package hls wraps gohlslib.Muxer into a small per-camera Sink: build the
// track list from whatever codecs the RTSP source actually offers (see
// camera.rtspBridge), translate generic Write calls into gohlslib's
// per-codec methods, and expose the muxer's own http.Handler for serving.
package hls

import (
	"net/http"
	"time"

	"github.com/bluenviron/gohlslib/v2"
	"github.com/bluenviron/gohlslib/v2/pkg/codecs"

	"stream-gateway/internal/codecparams"
)

// Sink is one camera's gohlslib.Muxer plus enough bookkeeping to route
// generic Write*(pts, samples) calls to the right per-codec method.
type Sink struct {
	muxer      *gohlslib.Muxer
	videoTrack *gohlslib.Track
	videoCodec string // "h264" | "h265" | ""
	audioTrack *gohlslib.Track
	audioCodec string // "mpeg4audio" | "opus" | ""
}

// NewSink builds and starts a gohlslib.Muxer for the given codec set.
// p.VideoH264/p.VideoH265 — exactly one must be set (a source with no
// supported video format never gets this far; camera.rtspBridge rejects it
// earlier). Audio params may both be nil (no audio track at all).
func NewSink(p codecparams.Set) (*Sink, error) {
	s := &Sink{}
	var tracks []*gohlslib.Track

	switch {
	case p.VideoH264 != nil:
		s.videoTrack = &gohlslib.Track{
			Codec:     &codecs.H264{SPS: p.VideoH264.SPS, PPS: p.VideoH264.PPS},
			ClockRate: p.VideoH264.ClockRate,
		}
		s.videoCodec = "h264"
		tracks = append(tracks, s.videoTrack)
	case p.VideoH265 != nil:
		s.videoTrack = &gohlslib.Track{
			Codec:     &codecs.H265{VPS: p.VideoH265.VPS, SPS: p.VideoH265.SPS, PPS: p.VideoH265.PPS},
			ClockRate: p.VideoH265.ClockRate,
		}
		s.videoCodec = "h265"
		tracks = append(tracks, s.videoTrack)
	}

	switch {
	case p.AudioMPEG4 != nil:
		s.audioTrack = &gohlslib.Track{
			Codec:     &codecs.MPEG4Audio{Config: p.AudioMPEG4.Config},
			ClockRate: p.AudioMPEG4.ClockRate,
		}
		s.audioCodec = "mpeg4audio"
		tracks = append(tracks, s.audioTrack)
	case p.AudioOpus != nil:
		s.audioTrack = &gohlslib.Track{
			Codec:     &codecs.Opus{ChannelCount: p.AudioOpus.ChannelCount},
			ClockRate: p.AudioOpus.ClockRate,
		}
		s.audioCodec = "opus"
		tracks = append(tracks, s.audioTrack)
	}

	s.muxer = &gohlslib.Muxer{Tracks: tracks}
	if err := s.muxer.Start(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Sink) WriteH264(pts int64, au [][]byte) error {
	if s.videoCodec != "h264" {
		return nil
	}
	return s.muxer.WriteH264(s.videoTrack, time.Now(), pts, au)
}

func (s *Sink) WriteH265(pts int64, au [][]byte) error {
	if s.videoCodec != "h265" {
		return nil
	}
	return s.muxer.WriteH265(s.videoTrack, time.Now(), pts, au)
}

func (s *Sink) WriteMPEG4Audio(pts int64, aus [][]byte) error {
	if s.audioCodec != "mpeg4audio" {
		return nil
	}
	return s.muxer.WriteMPEG4Audio(s.audioTrack, time.Now(), pts, aus)
}

func (s *Sink) WriteOpus(pts int64, packets [][]byte) error {
	if s.audioCodec != "opus" {
		return nil
	}
	return s.muxer.WriteOpus(s.audioTrack, time.Now(), pts, packets)
}

// Handler serves the HLS playlist/segments for this camera. Safe to call
// concurrently with the Write*/Close methods (gohlslib's own guarantee).
func (s *Sink) Handler() http.HandlerFunc {
	return s.muxer.Handle
}

func (s *Sink) Close() {
	s.muxer.Close()
}
