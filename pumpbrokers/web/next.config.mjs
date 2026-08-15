/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // `config/` lives one level up and is shared with the Anchor tests and
  // scripts, so it is deliberately outside this app's directory.
  experimental: { externalDir: true },

  // Arweave is the only remote image host we use.
  images: {
    remotePatterns: [{ protocol: "https", hostname: "arweave.net" }],
  },

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
