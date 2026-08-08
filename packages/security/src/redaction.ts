const PRIVATE_KEY_BLOCK =
  /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----[\s\S]*?-----END (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/gu;
const CREDENTIAL_ASSIGNMENT =
  /\b(?:access[_-]?token|api[_-]?key|authorization|client[_-]?secret|password|refresh[_-]?token|secret|token)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}/giu;
const KNOWN_TOKEN =
  /\b(?:AKIA[A-Z0-9]{16}|ASIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{30,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[baprs]-[A-Za-z0-9-]{10,}|ya29\.[A-Za-z0-9_-]{20,})\b/gu;
const CONTROL_CHARACTER = /\p{Cc}/gu;

function boundedText(value: string, maximumCharacters: number): string {
  const characters = [...value];
  if (characters.length <= maximumCharacters) return value;
  return `${characters.slice(0, maximumCharacters - 1).join("")}…`;
}

export function redactSensitiveText(
  value: string,
  maximumCharacters = 512,
): string {
  if (!Number.isSafeInteger(maximumCharacters) || maximumCharacters < 16) {
    throw new RangeError(
      "The redacted text limit must be a safe integer of at least 16.",
    );
  }
  const redacted = value
    .normalize("NFC")
    .replace(PRIVATE_KEY_BLOCK, "[REDACTED]")
    .replace(CREDENTIAL_ASSIGNMENT, "[REDACTED]")
    .replace(BEARER_TOKEN, "[REDACTED]")
    .replace(KNOWN_TOKEN, "[REDACTED]")
    .replace(CONTROL_CHARACTER, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return boundedText(
    redacted || "Sensitive detail was redacted.",
    maximumCharacters,
  );
}
