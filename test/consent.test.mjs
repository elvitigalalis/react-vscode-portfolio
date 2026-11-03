// The OAuth consent page's scope list (src/sheet/consent.mjs, scopeLines): what the person
// approving sees a client may do, one line per scope.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scopeLines } from "../src/sheet/consent.mjs";

test("scopeLines: known scopes in plain words, in the order asked", () => {
  assert.deepEqual(scopeLines("openid email profile"),
    ["Confirm that it is you", "See your email address", "See your name and profile picture"]);
  assert.deepEqual(scopeLines("phone"), ["See your phone number"]);
});

test("scopeLines: an unknown scope shows as its own name, never hidden", () => {
  assert.deepEqual(scopeLines("openid mail.read"), ["Confirm that it is you", "mail.read"]);
});

test("scopeLines: names that are also object keys show as themselves", () => {
  assert.deepEqual(scopeLines("constructor toString __proto__"), ["constructor", "toString", "__proto__"]);
});

test("scopeLines: extra spaces, tabs and newlines split cleanly; none or blank gives no lines", () => {
  assert.deepEqual(scopeLines("  openid\t\nemail  "), ["Confirm that it is you", "See your email address"]);
  assert.deepEqual(scopeLines(""), []);
  assert.deepEqual(scopeLines("   "), []);
  assert.deepEqual(scopeLines(undefined), []);
  assert.deepEqual(scopeLines(null), []);
});
