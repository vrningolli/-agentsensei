const PATTERNS: [RegExp, string][] = [
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g, '<api-key>'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '<github-token>'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '<aws-key>'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '<slack-token>'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '<jwt>'],
  [/\b(api[_-]?key|token|secret|password|passwd|pwd)(\s*[:=]\s*)\S+/gi, '$1$2<redacted>'],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>'],
];

/** Masks secrets and emails before text is printed or sent to an LLM. */
export function redact(text: string): string {
  return PATTERNS.reduce((out, [re, sub]) => out.replace(re, sub), text);
}

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
