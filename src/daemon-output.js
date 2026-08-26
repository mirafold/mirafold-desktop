// Credential-safe, memory-bounded handling of the daemon's stdout/stderr.
//
// Everything the daemon prints can leave this process — mirrored to the app's
// own stdout/stderr (captured by the system journal when launched from a
// desktop menu) or shown in a crash dialog (exactly what a user screenshots and
// shares). This module is the one place that decides what may leave: complete
// logical lines with both daemon-minted credentials redacted, and every buffer
// bounded in both line count and line length.

// Stderr kept for the crash dialog. Bounded because a daemon in a failure loop
// can produce output without limit, and this is held in memory for the life of
// the app. Bounded in BOTH directions — a hundred lines of unlimited length is
// not a bound, and agent output (which can be as long as a file someone else
// wrote) reaches this stream.
const STDERR_LINES = 100;
const STDERR_LINE_CHARS = 1000;

// A child stream can split anywhere — including between `tok` and `en=`, or
// between the pairing-code label and its value. Sanitizing each `data` chunk is
// therefore not sanitizing the stream. Hold one logical line until its newline,
// redact it as a whole, and elide rather than accumulate an attacker-sized line.
// The limit is deliberately larger than any legitimate Mirafold diagnostic;
// stderr is bounded more tightly again before it reaches a crash dialog.
const OUTPUT_LINE_CHARS = 16_384;
const OUTPUT_LINE_ELISION = "[mirafold desktop] overlong daemon output line elided";

// The daemon mints both values. The auth token grants local daemon access; the
// relay pairing code grants remote session access. Anything that leaves this
// process — mirrored child output or crash text — must strip both. The app's
// stdout/stderr is captured by the system journal when launched from a desktop
// menu, and a crash dialog is exactly what a user screenshots and shares.
const TOKEN_RE = /([?&]token=)[^\s&"'<>]+/gi;
const PAIRING_CODE_RE = /(\bpairing code\s*:\s*)[A-Za-z0-9_-]+/gi;

/** Replace complete credential values in one logical piece of text. */
export function redactCredentials(text) {
  return text.replace(TOKEN_RE, "$1<redacted>").replace(PAIRING_CODE_RE, "$1<redacted>");
}

/**
 * Turn arbitrarily chunked child output into credential-safe logical lines.
 *
 * `push()` returns only complete lines. `end()` safely releases a final line
 * without a newline. Once a logical line crosses the memory bound, none of its
 * prefix is released: the whole line becomes one fixed, non-secret marker.
 */
export class CredentialSafeLineStream {
  #pending = "";
  #dropping = false;
  #ended = false;

  push(text) {
    if (this.#ended || !text) return "";

    let safe = "";
    let start = 0;
    while (start < text.length) {
      const newline = text.indexOf("\n", start);
      const complete = newline !== -1;
      const end = complete ? newline : text.length;
      const part = text.slice(start, end);

      if (!this.#dropping) {
        if (this.#pending.length + part.length > OUTPUT_LINE_CHARS) {
          this.#pending = "";
          this.#dropping = true;
        } else {
          this.#pending += part;
        }
      }

      if (!complete) break;
      safe += this.#dropping
        ? `${OUTPUT_LINE_ELISION}\n`
        : `${redactCredentials(this.#pending)}\n`;
      this.#pending = "";
      this.#dropping = false;
      start = newline + 1;
    }
    return safe;
  }

  end() {
    if (this.#ended) return "";
    this.#ended = true;
    const safe = this.#dropping ? OUTPUT_LINE_ELISION : redactCredentials(this.#pending);
    this.#pending = "";
    this.#dropping = false;
    return safe;
  }
}

/**
 * Append `text`'s non-blank lines to `lines`, bounded by line count and line
 * length. The live path passes stream-sanitized text; redacting again keeps
 * this helper safe for complete standalone diagnostics and future callers.
 */
export function appendStderr(lines, text) {
  const next = lines.slice();
  for (const line of redactCredentials(text).split("\n")) {
    if (line.trim()) next.push(line.slice(0, STDERR_LINE_CHARS));
  }
  return next.length > STDERR_LINES ? next.slice(-STDERR_LINES) : next;
}
