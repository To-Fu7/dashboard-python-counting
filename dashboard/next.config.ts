import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // NOT 'standalone' — server.js is a hand-written custom server (proxies
  // /automation to Node-RED, HTTP + WebSocket) and can't be combined with
  // Next's own generated standalone server.js.
  serverExternalPackages: ['dockerode', 'docker-modem', 'ssh2', 'js-yaml'],
};

export default nextConfig;
