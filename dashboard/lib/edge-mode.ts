// This is the `edge` branch's identity, not a runtime toggle: a stripped
// down dashboard variant that only manages camera source config, live
// streaming (MSE/HLS/WebRTC via stream-gateway), and raw TCP port
// forwarding (nginx) — no Postgres/MQTT/Triton detection pipeline required
// to be running. Flip back to `false` (or merge from a branch where this
// constant doesn't exist) to restore the full detection-dashboard UI.
export const EDGE_MODE = true;
