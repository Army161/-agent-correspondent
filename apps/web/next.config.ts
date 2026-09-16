import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // The kernel and adapters are consumed as TypeScript source from the
  // workspace, so there is exactly one copy of the economic logic and no build
  // step between changing a rule and seeing it enforced.
  transpilePackages: ["@acor/core", "@acor/db", "@acor/adapters"],
  typedRoutes: false,
  experimental: {
    optimizePackageImports: ["lucide-react"],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
    ];
  },
};

export default config;
