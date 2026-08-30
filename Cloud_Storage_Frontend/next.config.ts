import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // The dev-mode floating indicator ("N" badge, dev-only — never appears in a
  // production build) sits as a fixed overlay and can intercept taps on nearby
  // controls on small mobile viewports. Disabling it in dev avoids that entirely.
  devIndicators: false,
};

export default nextConfig;
