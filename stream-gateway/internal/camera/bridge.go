package camera

import (
	"fmt"

	"github.com/bluenviron/gortsplib/v5"
	"github.com/bluenviron/gortsplib/v5/pkg/description"
	"github.com/bluenviron/gortsplib/v5/pkg/format"
	"github.com/bluenviron/gortsplib/v5/pkg/format/rtpsimpleaudio"
	"github.com/pion/rtp"

	"stream-gateway/internal/codecparams"
)

// sampleDecoder is the common shape of gortsplib's per-codec RTP decoders
// that matter here (H264/H265/MPEG4Audio all return potentially-multiple
// access units per RTP packet).
type sampleDecoder interface {
	Decode(pkt *rtp.Packet) ([][]byte, error)
}

// opusAdapter makes rtpsimpleaudio.Decoder (one frame per packet) satisfy
// sampleDecoder, since gohlslib's WriteOpus takes a slice regardless.
type opusAdapter struct {
	dec *rtpsimpleaudio.Decoder
}

func (a *opusAdapter) Decode(pkt *rtp.Packet) ([][]byte, error) {
	frame, err := a.dec.Decode(pkt)
	if err != nil {
		return nil, err
	}
	return [][]byte{frame}, nil
}

// rtspBridge picks the first supported video format (H264 or H265) and, if
// includeAudio, the first supported audio format (MPEG4Audio/AAC or Opus)
// out of an RTSP DESCRIBE response, SETUPs just those two medias, and — once
// attach() is called with a constructed Sink — forwards depacketized
// samples into it. G711 audio has no HLS muxer available (see the plan's
// known limitation) so it's never selected here; a G711-only camera simply
// gets no audio on the HLS path.
type rtspBridge struct {
	client *gortsplib.Client

	videoMedia *description.Media
	videoCodec string // "h264" | "h265" | ""
	videoForma format.Format
	videoDec   sampleDecoder
	h264Forma  *format.H264
	h265Forma  *format.H265

	audioMedia *description.Media
	audioCodec string // "mpeg4audio" | "opus" | ""
	audioForma format.Format
	audioDec   sampleDecoder
	mpeg4Forma *format.MPEG4Audio
	opusForma  *format.Opus
}

func newRTSPBridge(client *gortsplib.Client, desc *description.Session, includeAudio bool) (*rtspBridge, error) {
	b := &rtspBridge{client: client}

	// NOTE: Media.FindFormat's contract is "pass a pointer to the pointer
	// type you're looking for" (see gortsplib's own examples, e.g.
	// client-play-format-h264: `var forma *format.H264; medi.FindFormat(&forma)`).
	// A pointer to a *value* (`var h264 format.H264; medi.FindFormat(&h264)`)
	// never matches, since FindFormat compares reflect.TypeOf(forma).Elem()
	// (here: *format.H264) against the *format.H264 stored in Media.Formats.
	for _, medi := range desc.Medias {
		if b.videoMedia == nil {
			var h264 *format.H264
			if medi.FindFormat(&h264) {
				b.videoMedia, b.videoCodec, b.videoForma, b.h264Forma = medi, "h264", h264, h264
				continue
			}
			var h265 *format.H265
			if medi.FindFormat(&h265) {
				b.videoMedia, b.videoCodec, b.videoForma, b.h265Forma = medi, "h265", h265, h265
				continue
			}
		}
		if includeAudio && b.audioMedia == nil {
			var aac *format.MPEG4Audio
			if medi.FindFormat(&aac) {
				b.audioMedia, b.audioCodec, b.audioForma, b.mpeg4Forma = medi, "mpeg4audio", aac, aac
				continue
			}
			var opus *format.Opus
			if medi.FindFormat(&opus) {
				b.audioMedia, b.audioCodec, b.audioForma, b.opusForma = medi, "opus", opus, opus
				continue
			}
		}
	}

	if b.videoMedia == nil {
		return nil, fmt.Errorf("no supported video codec found (need H264 or H265)")
	}

	if _, err := client.Setup(desc.BaseURL, b.videoMedia, 0, 0); err != nil {
		return nil, fmt.Errorf("setup video: %w", err)
	}
	var err error
	switch b.videoCodec {
	case "h264":
		b.videoDec, err = b.h264Forma.CreateDecoder()
	case "h265":
		b.videoDec, err = b.h265Forma.CreateDecoder()
	}
	if err != nil {
		return nil, fmt.Errorf("video decoder: %w", err)
	}

	if b.audioMedia != nil {
		if _, err := client.Setup(desc.BaseURL, b.audioMedia, 0, 0); err != nil {
			return nil, fmt.Errorf("setup audio: %w", err)
		}
		switch b.audioCodec {
		case "mpeg4audio":
			b.audioDec, err = b.mpeg4Forma.CreateDecoder()
		case "opus":
			var d *rtpsimpleaudio.Decoder
			d, err = b.opusForma.CreateDecoder()
			if err == nil {
				b.audioDec = &opusAdapter{dec: d}
			}
		}
		if err != nil {
			return nil, fmt.Errorf("audio decoder: %w", err)
		}
	}

	return b, nil
}

func (b *rtspBridge) trackParams() codecparams.Set {
	p := codecparams.Set{}
	switch b.videoCodec {
	case "h264":
		p.VideoH264 = &codecparams.H264{SPS: b.h264Forma.SPS, PPS: b.h264Forma.PPS, ClockRate: b.videoForma.ClockRate()}
	case "h265":
		p.VideoH265 = &codecparams.H265{
			VPS: b.h265Forma.VPS, SPS: b.h265Forma.SPS, PPS: b.h265Forma.PPS,
			ClockRate: b.videoForma.ClockRate(),
		}
	}
	switch b.audioCodec {
	case "mpeg4audio":
		p.AudioMPEG4 = &codecparams.MPEG4Audio{Config: *b.mpeg4Forma.Config, ClockRate: b.audioForma.ClockRate()}
	case "opus":
		p.AudioOpus = &codecparams.Opus{ChannelCount: b.opusForma.ChannelCount, ClockRate: b.audioForma.ClockRate()}
	}
	return p
}

// sampleSink is whatever wants DECODED samples fanned out to it — hls.Sink
// and mse.Sink both structurally satisfy this.
type sampleSink interface {
	WriteH264(pts int64, au [][]byte) error
	WriteH265(pts int64, au [][]byte) error
	WriteMPEG4Audio(pts int64, aus [][]byte) error
	WriteOpus(pts int64, packets [][]byte) error
}

// rtpSink is whatever wants the RAW RTP packet, undecoded — webrtc.Sink
// (WebRTC already speaks RTP natively, so decoding would be wasted work
// only to re-encode nothing: the packet goes straight into a
// TrackLocalStaticRTP).
type rtpSink interface {
	WriteVideoRTP(pkt *rtp.Packet)
	WriteAudioRTP(pkt *rtp.Packet)
}

// attach wires the RTP callbacks that decode samples and fan them out to
// every sampleSink, and separately forwards the raw packet to every
// rtpSink. Must be called after the sinks have been built from
// trackParams() and before Play().
func (b *rtspBridge) attach(sinks []sampleSink, rtpSinks []rtpSink) {
	b.client.OnPacketRTP(b.videoMedia, b.videoForma, func(pkt *rtp.Packet) {
		for _, rs := range rtpSinks {
			rs.WriteVideoRTP(pkt)
		}

		pts, ok := b.client.PacketPTS(b.videoMedia, pkt)
		if !ok {
			return
		}
		au, err := b.videoDec.Decode(pkt)
		if err != nil {
			return
		}
		for _, sink := range sinks {
			switch b.videoCodec {
			case "h264":
				_ = sink.WriteH264(pts, au)
			case "h265":
				_ = sink.WriteH265(pts, au)
			}
		}
	})

	if b.audioMedia != nil {
		b.client.OnPacketRTP(b.audioMedia, b.audioForma, func(pkt *rtp.Packet) {
			for _, rs := range rtpSinks {
				rs.WriteAudioRTP(pkt)
			}

			pts, ok := b.client.PacketPTS(b.audioMedia, pkt)
			if !ok {
				return
			}
			samples, err := b.audioDec.Decode(pkt)
			if err != nil {
				return
			}
			for _, sink := range sinks {
				switch b.audioCodec {
				case "mpeg4audio":
					_ = sink.WriteMPEG4Audio(pts, samples)
				case "opus":
					_ = sink.WriteOpus(pts, samples)
				}
			}
		})
	}
}
