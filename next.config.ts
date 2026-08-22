import type { NextConfig } from "next";

const isGitHubPages = process.env.GITHUB_PAGES === "true";
const repositoryName = process.env.GITHUB_REPOSITORY?.split("/")[1] ?? "CogAR-label";
const repositoryBasePath = isGitHubPages ? `/${repositoryName}` : "";

const nextConfig: NextConfig = {
  output: isGitHubPages ? "export" : undefined,
  basePath: repositoryBasePath,
  assetPrefix: repositoryBasePath,
  images: {
    unoptimized: true,
  },
  typescript: {
    // The static Pages build does not include the Cloudflare-only D1 helper,
    // whose virtual module types are provided only by the Worker runtime.
    ignoreBuildErrors: isGitHubPages,
  },
};

export default nextConfig;
