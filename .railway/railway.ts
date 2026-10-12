import { defineRailway, project, service } from "railway/iac";
// This repository manages only its own resources in the environment. Other
// repositories export their own partial name.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = "youtube video downloader";
export default defineRailway(() => {
  const youtubeVideoDownloader = service("youtube video downloader", {
    // dockerfilePath from CaC: "Dockerfile"
    healthcheck: "/api/health",
    healthcheckTimeout: 300,
  });

  return project("balanced-heart", {
    variables: { managed: true },
    resources: [youtubeVideoDownloader],
  });
});
