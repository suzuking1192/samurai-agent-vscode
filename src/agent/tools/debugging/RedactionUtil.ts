/**
 * Redaction Utility
 * 
 * Redacts sensitive data before sending to LLM
 */

export interface Redaction {
  kind: 'secret' | 'pii' | 'token';
  placeholder: string;
  original: string;
}

export class RedactionUtil {
  // Secret patterns
  private readonly SECRET_PATTERNS = [
    // AWS tokens
    { regex: /AKIA[0-9A-Z]{16}/g, kind: 'secret' as const },
    // GCP tokens
    { regex: /ya29\.[\w\-_]+/g, kind: 'secret' as const },
    // GitHub tokens
    { regex: /gh[op]_[a-zA-Z0-9]{36}/g, kind: 'secret' as const },
    // JWTs
    { regex: /eyJ[A-Za-z0-9-_=]+\.eyJ[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*/g, kind: 'token' as const },
    // API keys (common patterns)
    { regex: /(api[_-]?key|apikey)[\s:=]+['"]?([a-zA-Z0-9\-_]{20,})['"]?/gi, kind: 'secret' as const },
    { regex: /(password|pwd|pass)[\s:=]+['"]?([^\s'"]{8,})['"]?/gi, kind: 'secret' as const },
    // Emails
    { regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, kind: 'pii' as const },
    // Phone numbers (US format)
    { regex: /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, kind: 'pii' as const }
  ];
  
  /**
   * Redact sensitive data from text
   */
  redactSensitiveData(text: string): { redacted: string; redactions: Redaction[] } {
    let redacted = text;
    const redactions: Redaction[] = [];
    
    // Apply each pattern
    for (const pattern of this.SECRET_PATTERNS) {
      const matches = text.matchAll(pattern.regex);
      
      for (const match of matches) {
        const original = match[0];
        const placeholder = `[${pattern.kind.toUpperCase()}_REDACTED]`;
        
        // Avoid double redaction
        if (!redacted.includes(placeholder)) {
          redacted = redacted.replace(original, placeholder);
          redactions.push({
            kind: pattern.kind,
            placeholder,
            original
          });
        }
      }
    }
    
    return { redacted, redactions };
  }
  
  /**
   * Truncate logs to sliding window around errors (last 200 lines around first error)
   */
  truncateLogsAroundError(logs: string): string {
    const lines = logs.split('\n');
    
    // Find first error line
    const errorLineIndex = lines.findIndex(line => 
      line.toLowerCase().includes('error:') || 
      line.toLowerCase().includes('exception:')
    );
    
    if (errorLineIndex === -1) {
      // No error found, return last 200 lines
      return lines.slice(-200).join('\n');
    }
    
    // Take 100 lines before and 100 lines after error
    const start = Math.max(0, errorLineIndex - 100);
    const end = Math.min(lines.length, errorLineIndex + 100);
    
    return lines.slice(start, end).join('\n');
  }
  
  /**
   * Hash requestIds if they look like PII
   */
  hashRequestIdIfPII(requestId: string): string {
    // Simple heuristic: if it's UUID format or long string, might be PII
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId);
    const isLongString = requestId.length > 20;
    
    if (isUuid || isLongString) {
      // Simple hash (not cryptographically secure, just for obfuscation)
      let hash = 0;
      for (let i = 0; i < requestId.length; i++) {
        hash = ((hash << 5) - hash) + requestId.charCodeAt(i);
        hash = hash & hash;
      }
      return `req_${Math.abs(hash).toString(16).substring(0, 8)}`;
    }
    
    return requestId;
  }
}

