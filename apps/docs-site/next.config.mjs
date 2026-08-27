import nextra from "nextra";

// Nextra handles the MDX pipeline, sidebar generation, and the built-in
// Flexsearch-powered search index — no extra config needed for search to
// work across every page in `pages/`.
const withNextra = nextra({
  theme: "nextra-theme-docs",
  themeConfig: "./theme.config.tsx",
  defaultShowCopyCode: true,
  staticImage: true,
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  eslint: {
    ignoreDuringBuilds: true,
  },
  // The docs site is deployed standalone at docs.airflex.io (see
  // .github/workflows/docs-ci.yml), so it does not need to share a
  // basePath with the marketing/app frontend in ../../frontend.
};

export default withNextra(nextConfig);
