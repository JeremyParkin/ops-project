// Whole-value link detection for plain text fields. Deliberately
// conservative: the ENTIRE field value must look like an absolute
// http(s) URL or a valid-looking email address, never a substring match.
// Anything ambiguous or malformed stays plain text -- this is presentation
// of an existing text value, not a new field type or a storage format.

export type LinkifiedText =
  | { kind: "url"; href: string; text: string }
  | { kind: "email"; href: string; text: string }
  | { kind: "plain"; text: string };

// Deliberately simple: local part with the common unquoted characters, an
// `@`, then one or more dot-separated domain labels (each alphanumeric,
// optionally hyphenated but never leading/trailing a hyphen). Requires at
// least one dot in the domain, so a bare "user@localhost"-style value is
// left as plain text rather than guessed at.
const EMAIL_PATTERN =
  /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

// Rejects any value containing a space, tab, newline, or other ASCII
// control character (codes 0x00-0x20, plus DEL 0x7F). The WHATWG URL
// parser silently strips some of these, which would let a value that
// visually contains whitespace resolve to a "clean" URL -- checked as raw
// character codes, not a regex, to keep the control-character range
// unambiguous.
function hasWhitespaceOrControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code <= 0x20 || code === 0x7f) {
      return true;
    }
  }

  return false;
}

function isConfidentUrl(value: string): boolean {
  if (value === "" || hasWhitespaceOrControlCharacter(value)) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isConfidentEmail(value: string): boolean {
  return (
    value !== "" &&
    !hasWhitespaceOrControlCharacter(value) &&
    EMAIL_PATTERN.test(value)
  );
}

export function linkifyText(value: string): LinkifiedText {
  if (isConfidentUrl(value)) {
    return { kind: "url", href: value, text: value };
  }

  if (isConfidentEmail(value)) {
    return { kind: "email", href: `mailto:${value}`, text: value };
  }

  return { kind: "plain", text: value };
}
