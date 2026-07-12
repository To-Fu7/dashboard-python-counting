package camera

import (
	"testing"

	"github.com/bluenviron/gortsplib/v5/pkg/format"
)

// Regression test for a real bug found live-testing against a production
// Hikvision-style H265 camera: its SDP didn't announce VPS/SPS/PPS at all
// (legal — some encoders only send them in-band), which made mse.NewSink
// fail immediately with "H265 parameters not provided" and — because all
// three sinks are built as one atomic step in connectOnce — took the
// entire camera connection down (HLS/WebRTC included) even though HLS
// itself would have tolerated the missing parameters. updateParamsFromAU
// is what recovers them from the actual bitstream instead of relying on
// the SDP.

func h264NALU(typ byte, payload ...byte) []byte {
	return append([]byte{typ & 0x1F}, payload...)
}

func h265NALU(typ byte, payload ...byte) []byte {
	// H265 NAL header is 2 bytes; type occupies bits 1-6 of the first byte.
	return append([]byte{typ << 1, 0}, payload...)
}

func TestUpdateParamsFromAU_H264_ExtractsInBandSPSPPS(t *testing.T) {
	b := &rtspBridge{videoCodec: "h264", h264Forma: &format.H264{}}

	if b.hasVideoParams() {
		t.Fatal("expected no params before any AU is processed")
	}

	// A slice/IDR frame with no parameter sets shouldn't satisfy hasVideoParams.
	b.updateParamsFromAU([][]byte{h264NALU(5, 0xAA, 0xBB)}) // IDR slice only
	if b.hasVideoParams() {
		t.Fatal("expected no params from an AU with no SPS/PPS")
	}

	// SPS+PPS arriving in-band (this camera's actual failure mode) should
	// be picked up and persisted via SafeSetParams.
	b.updateParamsFromAU([][]byte{
		h264NALU(7, 0x01, 0x02), // SPS
		h264NALU(8, 0x03),       // PPS
		h264NALU(5, 0xAA),       // IDR slice
	})
	if !b.hasVideoParams() {
		t.Fatal("expected params to be recognized after an AU containing SPS+PPS")
	}
	sps, pps := b.h264Forma.SafeParams()
	if len(sps) == 0 || len(pps) == 0 {
		t.Fatalf("expected non-empty SPS/PPS after extraction, got sps=%v pps=%v", sps, pps)
	}
}

func TestUpdateParamsFromAU_H265_ExtractsInBandVPSSPSPPS(t *testing.T) {
	b := &rtspBridge{videoCodec: "h265", h265Forma: &format.H265{}}

	if b.hasVideoParams() {
		t.Fatal("expected no params before any AU is processed")
	}

	// Only SPS+PPS, no VPS yet — H265 needs all three.
	b.updateParamsFromAU([][]byte{
		h265NALU(33, 0x01), // SPS_NUT
		h265NALU(34, 0x02), // PPS_NUT
	})
	if b.hasVideoParams() {
		t.Fatal("expected no params until VPS also arrives (H265 needs VPS+SPS+PPS)")
	}

	// VPS arrives in a later AU — this is exactly the real camera's
	// behavior (params spread across a couple of early access units).
	b.updateParamsFromAU([][]byte{
		h265NALU(32, 0x03), // VPS_NUT
	})
	if !b.hasVideoParams() {
		t.Fatal("expected params to be recognized once VPS/SPS/PPS have all been seen (across separate AUs)")
	}
	vps, sps, pps := b.h265Forma.SafeParams()
	if len(vps) == 0 || len(sps) == 0 || len(pps) == 0 {
		t.Fatalf("expected non-empty VPS/SPS/PPS, got vps=%v sps=%v pps=%v", vps, sps, pps)
	}
}

func TestUpdateParamsFromAU_PreAnnouncedSDPParamsAreNotClobbered(t *testing.T) {
	forma := &format.H264{SPS: []byte{0x11, 0x22}, PPS: []byte{0x33}}
	b := &rtspBridge{videoCodec: "h264", h264Forma: forma}

	// A well-behaved camera that already announced SPS/PPS in the SDP
	// (format.H264's fields are set directly by gortsplib's SDP parser, not
	// via SafeSetParams) must be recognized as ready without needing any
	// in-band AU at all.
	if !b.hasVideoParams() {
		t.Fatal("expected SDP-announced params to already satisfy hasVideoParams")
	}
}
