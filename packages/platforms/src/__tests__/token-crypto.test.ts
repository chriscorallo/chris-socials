import { describe, it, expect, beforeAll } from "vitest";
import { encryptToken, decryptToken, MissingEncryptionKeyError, InvalidEncryptedTokenError } from "../token-crypto";

describe("token-crypto (real AES-256-GCM, no mocking)", () => {
  beforeAll(() => {
    process.env.TOKEN_ENCRYPTION_KEY = "test-only-encryption-key-do-not-use-in-prod";
  });

  it("round-trips a real token", () => {
    const plaintext = "IGQVJ...a-real-looking-access-token...xyz";
    const encrypted = encryptToken(plaintext);
    expect(encrypted).not.toContain(plaintext);
    expect(decryptToken(encrypted)).toBe(plaintext);
  });

  it("produces a different ciphertext each time (random IV) even for the same plaintext", () => {
    const plaintext = "same-token";
    const a = encryptToken(plaintext);
    const b = encryptToken(plaintext);
    expect(a).not.toBe(b);
    expect(decryptToken(a)).toBe(plaintext);
    expect(decryptToken(b)).toBe(plaintext);
  });

  it("rejects a tampered ciphertext instead of silently returning garbage", () => {
    const encrypted = encryptToken("a-token");
    const parts = encrypted.split(":");
    const tampered = [parts[0], parts[1], Buffer.from("tampered-ciphertext").toString("base64")].join(":");
    expect(() => decryptToken(tampered)).toThrow();
  });

  it("throws a clear error for a malformed stored value", () => {
    expect(() => decryptToken("not-the-right-format")).toThrow(InvalidEncryptedTokenError);
  });

  it("throws a clear error when TOKEN_ENCRYPTION_KEY is unset", () => {
    const saved = process.env.TOKEN_ENCRYPTION_KEY;
    delete process.env.TOKEN_ENCRYPTION_KEY;
    try {
      expect(() => encryptToken("x")).toThrow(MissingEncryptionKeyError);
    } finally {
      process.env.TOKEN_ENCRYPTION_KEY = saved;
    }
  });
});
