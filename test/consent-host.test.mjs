// The consent page's allowlist (src/sheet/consent.mjs): only Claude may be approved, judged by
// the host the authorization would send the browser back to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { trustedRedirect } from "../src/sheet/consent.mjs";

test("trustedRedirect: claude.ai and claude.com, or a subdomain of either, over https", () => {
  for (const uri of [
    "https://claude.ai/api/mcp/auth_callback",
    "https://claude.com/api/mcp/auth_callback",
    "https://www.claude.ai/cb",
    "https://app.eu.claude.com/cb?x=1",
    "https://CLAUDE.AI/cb",
  ]) assert.equal(trustedRedirect(uri), true, uri);
});

test("trustedRedirect: lookalikes, other schemes and junk are not Claude", () => {
  for (const uri of [
    "https://claude.ai.evil.example/cb",
    "https://evilclaude.ai/cb",
    "https://notclaude.com/cb",
    "https://claude.ai@evil.example/cb",
    "http://claude.ai/cb",
    "javascript:alert(1)//claude.ai",
    "https://evil.example/?r=https://claude.ai/",
    "http://localhost:6274/oauth/callback",
    "",
    undefined,
    null,
    "not a url",
  ]) assert.equal(trustedRedirect(uri), false, String(uri));
});
