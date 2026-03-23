/** Redact API keys and tokens from error messages and URLs */
export function redactSecrets(text: string): string {
  return text
    .replace(/([?&])(key|token|api_key|apikey)=[^&\s]+/gi, "$1$2=REDACTED")
    .replace(/(Authorization:\s*)(Token|Bearer)\s+\S+/gi, "$1$2 REDACTED")
    .replace(/(xi-api-key:\s*)\S+/gi, "$1REDACTED")
    .replace(/(Ocp-Apim-Subscription-Key:\s*)\S+/gi, "$1REDACTED")
    .replace(/(X-API-Key:\s*)\S+/gi, "$1REDACTED")
    .replace(/(X-goog-api-key:\s*)\S+/gi, "$1REDACTED");
}
