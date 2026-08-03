// Pins the 2026-08-03 audit finding: the will-navigate guard permitted any
// file:// URL, so a link in agent output pointed at ~/.ssh/id_rsa satisfied it.
// Chromium refuses http -> file navigation on its own, which is why nothing was
// exploitable — but that is Chromium's rule, not ours, and this is ours.
import { test } from "node:test";
import assert from "node:assert/strict";
import { navigationVerdict } from "../src/navigation.js";

const LOADING = "/opt/Mirafold/resources/app/src/loading.html";

test("arbitrary local files are refused", () => {
  for (const url of [
    "file:///etc/passwd",
    "file:///home/kyle/.ssh/id_rsa",
    "file:///tmp/agent-written-evil.html",
    "file:///opt/Mirafold/resources/app/src/../../../../etc/shadow",
  ]) {
    assert.equal(navigationVerdict(url, LOADING), "block", url);
  }
});

test("the daemon and the loading screen are allowed", () => {
  assert.equal(navigationVerdict("http://127.0.0.1:5173/?token=abc", LOADING), "allow");
  assert.equal(navigationVerdict("http://127.0.0.1:31337/session/1", LOADING), "allow");
  assert.equal(navigationVerdict(`file://${LOADING}`, LOADING), "allow");
});

test("web pages go to the browser, never this window", () => {
  assert.equal(navigationVerdict("https://mirafold.com/", LOADING), "external");
  assert.equal(navigationVerdict("http://localhost:3000/", LOADING), "external");
});

test("a lookalike host does not pass as the daemon", () => {
  // userinfo before @ — the real host is evil.com
  assert.equal(navigationVerdict("http://127.0.0.1:3000@evil.com/", LOADING), "external");
  assert.equal(navigationVerdict("http://127.0.0.1.evil.com/", LOADING), "external");
});

test("schemes the OS would act on are never handed onwards", () => {
  // "external" is the only verdict that reaches shell.openExternal, so these
  // must not produce it: openExternal on smb:/vbscript:/a .desktop file asks
  // the operating system to go do something.
  for (const url of [
    "javascript:alert(1)",
    "mailto:someone@example.com",
    "smb://attacker/share/payload.exe",
    "vbscript:msgbox(1)",
    "not a url at all",
  ]) {
    assert.equal(navigationVerdict(url, LOADING), "block", url);
  }
});
