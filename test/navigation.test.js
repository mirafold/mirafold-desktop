// Pins the 2026-08-03 audit finding: the will-navigate guard permitted any
// file:// URL, so a link in agent output pointed at ~/.ssh/id_rsa satisfied it.
// Chromium refuses http -> file navigation on its own, which is why nothing was
// exploitable — but that is Chromium's rule, not ours, and this is ours.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  daemonOriginFromUrl,
  navigationVerdict,
  popupVerdict,
} from "../src/navigation.js";

// Built the way main.js builds it (path.join on the app directory) so the
// fixture is a real path on whichever platform the suite runs — a hardcoded
// POSIX path never matches what fileURLToPath returns on Windows.
const LOADING = path.resolve("opt/Mirafold/resources/app/src/loading.html");
const DAEMON_URL = "http://127.0.0.1:31337/?token=private";
const DAEMON_ORIGIN = daemonOriginFromUrl(DAEMON_URL);

assert.equal(DAEMON_ORIGIN, "http://127.0.0.1:31337");

test("arbitrary local files are refused", () => {
  for (const url of [
    "file:///etc/passwd",
    "file:///home/kyle/.ssh/id_rsa",
    "file:///tmp/agent-written-evil.html",
    "file:///opt/Mirafold/resources/app/src/../../../../etc/shadow",
  ]) {
    assert.equal(navigationVerdict(url, LOADING, DAEMON_ORIGIN), "block", url);
  }
});

test("only this launch's daemon origin and the loading screen are allowed", () => {
  assert.equal(navigationVerdict(DAEMON_URL, LOADING, DAEMON_ORIGIN), "allow");
  assert.equal(
    navigationVerdict("http://127.0.0.1:31337/session/1", LOADING, DAEMON_ORIGIN),
    "allow",
  );
  assert.equal(navigationVerdict(pathToFileURL(LOADING).href, LOADING, DAEMON_ORIGIN), "allow");
});

test("other loopback listeners are external, not trusted as the daemon", () => {
  assert.equal(
    navigationVerdict("http://127.0.0.1:5173/?token=abc", LOADING, DAEMON_ORIGIN),
    "external",
  );
  assert.equal(
    navigationVerdict("https://127.0.0.1:31337/session/1", LOADING, DAEMON_ORIGIN),
    "external",
  );
  assert.equal(navigationVerdict(DAEMON_URL, LOADING, null), "external");
});

test("web pages go to the browser, never this window", () => {
  assert.equal(navigationVerdict("https://mirafold.com/", LOADING, DAEMON_ORIGIN), "external");
  assert.equal(
    navigationVerdict("http://localhost:3000/", LOADING, DAEMON_ORIGIN),
    "external",
  );
});

test("a lookalike host does not pass as the daemon", () => {
  // userinfo before @ — the real host is evil.com
  assert.equal(
    navigationVerdict("http://127.0.0.1:3000@evil.com/", LOADING, DAEMON_ORIGIN),
    "external",
  );
  assert.equal(
    navigationVerdict("http://127.0.0.1.evil.com/", LOADING, DAEMON_ORIGIN),
    "external",
  );
});

test("daemon origins are derived only from explicit HTTP IPv4 loopback URLs", () => {
  assert.equal(daemonOriginFromUrl("http://127.0.0.1:31337/session?token=private"), DAEMON_ORIGIN);
  assert.equal(daemonOriginFromUrl("http://127.0.0.1:80/?token=private"), "http://127.0.0.1");
  for (const url of [
    "http://127.0.0.1/",
    " http://127.0.0.1:31337/",
    "https://127.0.0.1:31337/",
    "http://localhost:31337/",
    "http://127.0.0.1.evil.com:31337/",
    "file:///tmp/page.html",
    "not a url",
  ]) {
    assert.equal(daemonOriginFromUrl(url), null, url);
  }
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
    assert.equal(navigationVerdict(url, LOADING, DAEMON_ORIGIN), "block", url);
  }
});

test("only Shell's exact new-session GET popup stays in the desktop window", () => {
  assert.equal(
    popupVerdict("http://127.0.0.1:31337/?new=1", DAEMON_ORIGIN),
    "same-window",
  );
  assert.equal(
    popupVerdict(
      "http://127.0.0.1:31337/?new=1#code=private&relay=wss%3A%2F%2Frelay.example",
      DAEMON_ORIGIN,
    ),
    "same-window",
  );

  for (const url of [
    "http://127.0.0.1:31337/",
    "http://127.0.0.1:31337/session/1",
    "http://127.0.0.1:31337/?new=1&extra=1",
    "http://user@127.0.0.1:31337/?new=1",
    "http://127.0.0.1:41337/?new=1",
    "https://mirafold.com/?new=1",
  ]) {
    assert.equal(popupVerdict(url, DAEMON_ORIGIN), "external", url);
  }

  for (const url of [
    "javascript:alert(1)",
    "mailto:someone@example.com",
    "file:///tmp/page.html",
    "not a url",
  ]) {
    assert.equal(popupVerdict(url, DAEMON_ORIGIN), "block", url);
  }

  assert.equal(
    popupVerdict("http://127.0.0.1:31337/?new=1", DAEMON_ORIGIN, true),
    "block",
    "a form POST must not be converted into a bodyless GET",
  );
});
