import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',
  serverExternalPackages: ['dockerode', 'docker-modem', 'ssh2', 'js-yaml'],
};

export default nextConfig;
