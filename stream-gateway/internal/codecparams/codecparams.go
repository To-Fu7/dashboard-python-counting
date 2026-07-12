// Package codecparams holds the codec info camera.rtspBridge extracts from
// an RTSP DESCRIBE response, in a form independent of any single output
// library. hls.NewSink, mse.NewWriter, and webrtc.NewSession each take a
// Set and translate it into their own library's codec types (gohlslib's
// pkg/codecs, mediacommon's pkg/formats/mp4/codecs, and pion's
// webrtc.RTPCodecCapability respectively) — this type can't live in
// package camera itself since camera imports hls (a cycle would result).
package codecparams

import "github.com/bluenviron/mediacommon/v2/pkg/codecs/mpeg4audio"

type H264 struct {
	SPS, PPS  []byte
	ClockRate int
}

type H265 struct {
	VPS, SPS, PPS []byte
	ClockRate     int
}

type MPEG4Audio struct {
	Config    mpeg4audio.AudioSpecificConfig
	ClockRate int
}

type Opus struct {
	ChannelCount int
	ClockRate    int
}

// Set describes the codecs an RTSP source actually offers, as determined by
// camera.rtspBridge from the DESCRIBE response. Video is H264 XOR H265;
// audio is MPEG4Audio(AAC) XOR Opus XOR absent — G711 has no HLS/MSE muxer
// available (see the plan's known limitation), so a G711-only source simply
// gets no audio on those two paths (WebRTC can still carry it directly).
type Set struct {
	VideoH264  *H264
	VideoH265  *H265
	AudioMPEG4 *MPEG4Audio
	AudioOpus  *Opus
}
