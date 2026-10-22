// The commit this build comes from: GitHub Actions' GITHUB_SHA when deployed, else the local HEAD.
// The footer links it, and the hero's plant grows from it. Empty when neither is known.
import { execSync } from "node:child_process";

let sha = process.env.GITHUB_SHA ?? "";
if (!sha) {
  try { sha = execSync("git rev-parse HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch {}
}

export const commit = sha;
export const shortCommit = sha.slice(0, 7);
