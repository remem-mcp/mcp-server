import { describe, expect, it } from "vitest";

import { redactSecrets } from "../src/redact.js";

describe("redactSecrets", () => {
  const masked = (input: string): string => redactSecrets(input).text;

  it("masks well-known token formats", () => {
    const samples = [
      "AKIAIOSFODNN7EXAMPLE",
      `ghp_${"a".repeat(36)}`,
      `github_pat_${"A1b2".repeat(8)}`,
      `sk-${"x".repeat(32)}`,
      "xoxb-123456789012-abcdefghijkl",
      `AIza${"B".repeat(35)}`,
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    ];
    for (const secret of samples) {
      const result = redactSecrets(`deployed with ${secret} today`);
      expect(result.text, secret).toBe("deployed with [REDACTED] today");
      expect(result.count).toBe(1);
    }
  });

  it("masks values of secret-looking assignments but keeps the key", () => {
    expect(masked("password: hunter2!")).toBe("password: [REDACTED]");
    expect(masked('API_KEY="abc123def"')).toBe('API_KEY="[REDACTED]"');
    expect(masked("export DB_PASSWORD=s3cr3tValue")).toBe("export DB_PASSWORD=[REDACTED]");
    expect(masked("client_secret = 'zzzz9999'")).toBe("client_secret = '[REDACTED]'");
    expect(masked("パスワード: abcd1234 に変更")).toBe("パスワード: [REDACTED] に変更");
  });

  it("masks authorization headers, URL credentials and private keys", () => {
    expect(masked("curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345'")).toContain("Bearer [REDACTED]");
    expect(masked("postgres://admin:topsecret@db.example.com/app")).toBe("postgres://admin:[REDACTED]@db.example.com/app");
    expect(masked("-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nIBAAK\n-----END RSA PRIVATE KEY-----")).toBe("[REDACTED]");
  });

  it("leaves ordinary text alone", () => {
    const texts = [
      "Reviewed PR #123 and fixed the login page",
      "パスワードの再設定画面を実装した",
      "Decided to rotate the API key every 90 days",
      "token の有効期限を 1 時間に変更",
      "https://example.com/docs/page?id=42",
      "commit 9fceb02d0ae598e95dc970b74767f19372d61af8",
    ];
    for (const text of texts) {
      expect(redactSecrets(text)).toEqual({ text, count: 0 });
    }
  });

  it("counts every masked value and is stable when applied twice", () => {
    const once = redactSecrets("password=abcdef12 and token: zyxwvu98");
    expect(once.count).toBe(2);
    expect(redactSecrets(once.text)).toEqual({ text: once.text, count: 0 });
  });
});
