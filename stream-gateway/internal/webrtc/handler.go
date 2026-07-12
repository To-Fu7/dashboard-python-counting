package webrtc

import (
	"fmt"
	"io"
	"net/http"
	"sync"

	"github.com/pion/interceptor"
	"github.com/pion/webrtc/v4"
)

var peerConnectionConfig = webrtc.Configuration{
	ICEServers: []webrtc.ICEServer{
		{URLs: []string{"stun:stun.l.google.com:19302"}},
	},
}

// newAPI builds a pion API object with just the codec(s) this camera
// actually has, and the fixed UDP mux from SettingEngine (see config.go) so
// every WebRTC session across every camera shares one published UDP port
// instead of needing an ephemeral range in compose.
func newAPI(sink *Sink, settingEngine webrtc.SettingEngine) (*webrtc.API, error) {
	mediaEngine := &webrtc.MediaEngine{}

	if sink.hasVideo {
		if err := mediaEngine.RegisterCodec(webrtc.RTPCodecParameters{
			RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeH264, ClockRate: 90000},
			PayloadType:        96,
		}, webrtc.RTPCodecTypeVideo); err != nil {
			return nil, err
		}
	}
	if sink.audioTrack != nil {
		if err := mediaEngine.RegisterCodec(webrtc.RTPCodecParameters{
			RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2},
			PayloadType:        97,
		}, webrtc.RTPCodecTypeAudio); err != nil {
			return nil, err
		}
	}

	interceptorRegistry := &interceptor.Registry{}
	if err := webrtc.RegisterDefaultInterceptors(mediaEngine, interceptorRegistry); err != nil {
		return nil, err
	}

	return webrtc.NewAPI(
		webrtc.WithMediaEngine(mediaEngine),
		webrtc.WithInterceptorRegistry(interceptorRegistry),
		webrtc.WithSettingEngine(settingEngine),
	), nil
}

// HandleOffer answers one WHEP POST (SDP offer body -> 201 + Location +
// answer SDP body). release is called exactly once (guarded internally)
// when this specific viewer's session ends, however that happens — ICE
// failure, a later DELETE, or the camera itself going away — so the
// caller's viewer-count bookkeeping (camera.Source.AcquireViewer's release
// func) stays accurate regardless of which path triggered the teardown.
// settingEngine is shared process-wide (holds the fixed UDP mux — see
// config.go/main.go) so every camera's sessions use the same published port.
func HandleOffer(sink *Sink, settingEngine webrtc.SettingEngine, release func(), w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "POST, DELETE")
	w.Header().Set("Access-Control-Allow-Headers", "*")

	if !sink.hasVideo {
		release()
		http.Error(w, "camera has no WebRTC-compatible video codec (H264 required)", http.StatusServiceUnavailable)
		return
	}

	offer, err := io.ReadAll(r.Body)
	if err != nil {
		release()
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	api, err := newAPI(sink, settingEngine)
	if err != nil {
		release()
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	pc, err := api.NewPeerConnection(peerConnectionConfig)
	if err != nil {
		release()
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	if _, err := pc.AddTrack(sink.videoTrack); err != nil {
		_ = pc.Close()
		release()
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if sink.audioTrack != nil {
		if _, err := pc.AddTrack(sink.audioTrack); err != nil {
			_ = pc.Close()
			release()
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
	}

	var releaseOnce sync.Once
	pc.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
		switch state {
		case webrtc.ICEConnectionStateFailed:
			_ = pc.Close() // triggers the Closed case below via pion's own state machine
		case webrtc.ICEConnectionStateClosed, webrtc.ICEConnectionStateDisconnected:
			releaseOnce.Do(release)
		}
	})

	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: string(offer)}); err != nil {
		_ = pc.Close()
		release()
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	gatherComplete := webrtc.GatheringCompletePromise(pc)

	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		_ = pc.Close()
		release()
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	if err := pc.SetLocalDescription(answer); err != nil {
		_ = pc.Close()
		release()
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	// Non-trickle: exchange exactly one SDP each way, matching the WHEP
	// spec's simplest supported mode. Fine for a LAN-only deployment.
	<-gatherComplete

	id := sink.addSession(pc)

	w.Header().Set("Content-Type", "application/sdp")
	w.Header().Set("Location", fmt.Sprintf("%s/%s", r.URL.Path, id))
	w.WriteHeader(http.StatusCreated)
	_, _ = w.Write([]byte(pc.LocalDescription().SDP))
}

// HandleTeardown answers a WHEP DELETE — closeSession's pc.Close() drives
// the same OnICEConnectionStateChange -> release() path HandleOffer wires
// up, so the viewer-count bookkeeping stays correct here too.
func HandleTeardown(sink *Sink, w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	id := r.PathValue("sessionId")
	if !sink.closeSession(id) {
		http.Error(w, "session not found", http.StatusNotFound)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
