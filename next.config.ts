import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Exclude the synthetic test pack from serverless bundles.
  outputFileTracingExcludes: { "*": ["samples/**", "scripts/**"] },
};

export default nextConfig;
