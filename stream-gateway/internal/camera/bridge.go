package camera

import (
	"fmt"
	"log"
	"sync"
	"sync/atomic"

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
//
// Many real cameras (confirmed live against a production Hikvision-style
// H265 stream) don't announce SPS/PPS/VPS in the SDP at all — they send
// them in-band as ordinary NAL units instead, which is legal per RTP but
// means the format.H264/H265 structs FindFormat gives us can start out
// completely empty. attach() extracts them from the first access units
// that carry them (via gortsplib's own SafeSetParams — a manual API no
// caller in gortsplib itself invokes) so trackParams() has real data by
// the time the sinks actually need it (see Source.connectOnce's priming
// wait).
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

	mu       sync.Mutex
	sinks    []sampleSink
	rtpSinks []rtpSink

	sinkErrOnce sync.Once // logs only the first sink write error, not one per frame

	debugAUCount atomic.Int64 // TEMP: live-debugging real H265 camera HLS stall
}

// logSinkErrorOnce surfaces the first sink Write* error to the log. These
// were previously discarded entirely — found live-testing against a real
// camera that every single frame can fail to write (e.g. a malformed
// parameter set) with zero visibility into why the camera never produces
// any HLS/MSE output. Only the first is logged (not rate-limited further)
// since a persistently-failing sink would otherwise flood the log at full
// frame rate for as long as the connection stays up.
func (b *rtspBridge) logSinkErrorOnce(err error) {
	if err == nil {
		return
	}
	b.sinkErrOnce.Do(func() {
		log.Printf("sink write error (logged once, further errors on this connection are suppressed): %v", err)
	})
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

// hasVideoParams reports whether we currently know the parameter sets
// (SPS/PPS, or VPS/SPS/PPS for H265) this video codec needs to build an
// HLS/MSE init segment — either because the SDP announced them, or because
// updateParamsFromAU has since extracted them from an in-band NAL unit.
func (b *rtspBridge) hasVideoParams() bool {
	switch b.videoCodec {
	case "h264":
		sps, pps := b.h264Forma.SafeParams()
		return len(sps) > 0 && len(pps) > 0
	case "h265":
		vps, sps, pps := b.h265Forma.SafeParams()
		return len(vps) > 0 && len(sps) > 0 && len(pps) > 0
	default:
		return false
	}
}

// updateParamsFromAU scans a decoded access unit for parameter-set NAL
// units and, if found, records them via SafeSetParams so a later
// trackParams() call (and hasVideoParams above) sees them. gortsplib itself
// never calls SafeSetParams — extracting in-band parameters is left
// entirely to the caller, which is what this does.
func (b *rtspBridge) updateParamsFromAU(au [][]byte) {
	switch b.videoCodec {
	case "h264":
		var sps, pps []byte
		for _, nalu := range au {
			if len(nalu) == 0 {
				continue
			}
			switch nalu[0] & 0x1F {
			case 7: // SPS
				sps = nalu
			case 8: // PPS
				pps = nalu
			}
		}
		if sps != nil || pps != nil {
			// Merge with whatever's already known and save the merge
			// unconditionally — a real camera can (and did, live) send SPS
			// and PPS in separate access units, so a partial discovery here
			// must still be persisted for a later AU to complete, not
			// discarded just because this one AU alone isn't complete.
			curSPS, curPPS := b.h264Forma.SafeParams()
			if sps == nil {
				sps = curSPS
			}
			if pps == nil {
				pps = curPPS
			}
			b.h264Forma.SafeSetParams(sps, pps)
		}
	case "h265":
		var vps, sps, pps []byte
		for _, nalu := range au {
			if len(nalu) < 2 {
				continue
			}
			switch (nalu[0] >> 1) & 0x3F {
			case 32: // VPS_NUT
				vps = nalu
			case 33: // SPS_NUT
				sps = nalu
			case 34: // PPS_NUT
				pps = nalu
			}
		}
		if vps != nil || sps != nil || pps != nil {
			// Same "persist partial discoveries" reasoning as H264 above —
			// confirmed live that a real camera can spread VPS/SPS/PPS
			// across more than one access unit.
			curVPS, curSPS, curPPS := b.h265Forma.SafeParams()
			if vps == nil {
				vps = curVPS
			}
			if sps == nil {
				sps = curSPS
			}
			if pps == nil {
				pps = curPPS
			}
			b.h265Forma.SafeSetParams(vps, sps, pps)
		}
	}
}

// trackParams reads the CURRENT (possibly in-band-discovered, via
// SafeParams) codec parameters. Call after hasVideoParams() is true.
func (b *rtspBridge) trackParams() codecparams.Set {
	p := codecparams.Set{}
	switch b.videoCodec {
	case "h264":
		sps, pps := b.h264Forma.SafeParams()
		p.VideoH264 = &codecparams.H264{SPS: sps, PPS: pps, ClockRate: b.videoForma.ClockRate()}
	case "h265":
		vps, sps, pps := b.h265Forma.SafeParams()
		p.VideoH265 = &codecparams.H265{VPS: vps, SPS: sps, PPS: pps, ClockRate: b.videoForma.ClockRate()}
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

// setSinks switches attach()'s already-running callbacks over to forwarding
// into real sinks. Safe to call concurrently with the RTP callbacks (mu-guarded).
func (b *rtspBridge) setSinks(sinks []sampleSink, rtpSinks []rtpSink) {
	b.mu.Lock()
	b.sinks = sinks
	b.rtpSinks = rtpSinks
	b.mu.Unlock()
}

func (b *rtspBridge) currentSinks() ([]sampleSink, []rtpSink) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.sinks, b.rtpSinks
}

// attach wires the RTP callbacks that decode samples, extract in-band codec
// parameters, and fan decoded samples/raw packets out to whatever sinks are
// currently set (none, until a later setSinks call). Must be called once,
// before Play() (see Source.connectOnce): the callbacks still run the full
// decode + parameter-extraction path with no sinks attached, which is
// exactly the priming Source.connectOnce needs while it waits for
// hasVideoParams() to go true before building the real sinks and calling
// setSinks(...) — gortsplib gives no thread-safety guarantee for changing
// callbacks after Play(), so the callbacks themselves are registered
// exactly once and only the sink slice they read is ever swapped.
func (b *rtspBridge) attach() {
	b.client.OnPacketRTP(b.videoMedia, b.videoForma, func(pkt *rtp.Packet) {
		au, err := b.videoDec.Decode(pkt)
		if err != nil {
			return
		}
		b.updateParamsFromAU(au)

		sinks, rtpSinks := b.currentSinks()
		for _, rs := range rtpSinks {
			rs.WriteVideoRTP(pkt)
		}
		if len(sinks) == 0 {
			return
		}
		pts, ok := b.client.PacketPTS(b.videoMedia, pkt)
		if !ok {
			return
		}
		n := b.debugAUCount.Add(1)
		if n <= 5 || n%50 == 0 {
			types := make([]int, 0, len(au))
			for _, nalu := range au {
				if len(nalu) == 0 {
					continue
				}
				if b.videoCodec == "h265" {
					types = append(types, int((nalu[0]>>1)&0x3F))
				} else {
					types = append(types, int(nalu[0]&0x1F))
				}
			}
			log.Printf("DEBUG video AU #%d pts=%d nalCount=%d nalTypes=%v sinks=%d", n, pts, len(au), types, len(sinks))
		}

		for _, sink := range sinks {
			var err error
			switch b.videoCodec {
			case "h264":
				err = sink.WriteH264(pts, au)
			case "h265":
				err = sink.WriteH265(pts, au)
			}
			if err != nil && (n <= 5 || n%50 == 0) {
				log.Printf("DEBUG video AU #%d write error: %v", n, err)
			}
			b.logSinkErrorOnce(err)
		}
	})

	if b.audioMedia != nil {
		b.client.OnPacketRTP(b.audioMedia, b.audioForma, func(pkt *rtp.Packet) {
			sinks, rtpSinks := b.currentSinks()
			for _, rs := range rtpSinks {
				rs.WriteAudioRTP(pkt)
			}
			if len(sinks) == 0 {
				return
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
				var err error
				switch b.audioCodec {
				case "mpeg4audio":
					err = sink.WriteMPEG4Audio(pts, samples)
				case "opus":
					err = sink.WriteOpus(pts, samples)
				}
				b.logSinkErrorOnce(err)
			}
		})
	}
}
