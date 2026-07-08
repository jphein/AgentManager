import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";

const nextConfig: NextConfig = {
  output: isDev ? undefined : "export",
  distDir: "dist",
  trailingSlash: true,
  // In dev, proxy /api/* to the Express server (SERVER_PORT, default 8080)
  ...(isDev
    ? {
        async rewrites() {
          return [
            {
              source: "/api/:path*",
              destination: `http://localhost:${process.env.SERVER_PORT ?? "8080"}/api/:path*`,
            },
          ];
        },
      }
    : {}),
};

export default nextConfig;
