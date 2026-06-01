/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [
      // Add image source domains here as needed, e.g.:
      // { protocol: 'https', hostname: 'images.example.com' },
    ],
  },
};

module.exports = nextConfig;
