import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          {
            key: "Content-Security-Policy",
            value:
              "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
          },
        ],
      },
    ];
  },
  agentRules: false,
  cacheComponents: true,
  partialPrefetching: true,
  // Operator configuration is runtime-only and must never enter build traces.
  outputFileTracingExcludes: {
    "/*": [
      "./.env*",
      "./**/operator.env",
      "./**/*.key",
      "./**/*keypair*.json",
      "./**/wallet*.json",
    ],
  },
};

export default nextConfig;
