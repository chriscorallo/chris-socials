import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/**
 * AES-256-GCM encryption for platform credentials at rest — spec §22 ("Encrypted token
 * storage for platform credentials... with refresh handling"). Application-layer encryption
 * (not a cloud KMS) is the deliberate, reversible choice for this stack: no KMS is provisioned
 * yet, and swapping this module's internals for a KMS-backed one later doesn't change
 * `PlatformCredential`'s schema (still `encryptedAccessToken: String`) — see
 * /docs/DECISIONS.md.
 *
 * `TOKEN_ENCRYPTION_KEY` must be a real secret, set via environment variable / secret manager
 * per CLAUDE.md's "never commit secrets" rule — `.env.example` holds only a placeholder.
 */
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit nonce, the GCM-recommended size
const SALT = "chris-content-intelligence-token-crypto"; // fixed, non-secret — see scryptSync note below

export class MissingEncryptionKeyError extends Error {
  constructor() {
    super(
      "TOKEN_ENCRYPTION_KEY is not set — cannot encrypt/decrypt platform credentials. See " +
        ".env.example.",
    );
    this.name = "MissingEncryptionKeyError";
  }
}

/**
 * Derives a 32-byte key from the configured secret via scrypt. The salt here is fixed and
 * non-secret (scrypt's slow, memory-hard KDF is the actual protection against a weak
 * TOKEN_ENCRYPTION_KEY being brute-forced, not salt secrecy) — this only needs to be
 * deterministic per-process, not unique per-credential, since the real secret is the env var.
 */
function deriveKey(): Buffer {
  const secret = process.env.TOKEN_ENCRYPTION_KEY;
  if (!secret) throw new MissingEncryptionKeyError();
  return scryptSync(secret, SALT, 32);
}

/** `iv:authTag:ciphertext`, each base64 — a single string so it fits the existing
 * `encryptedAccessToken: String` column without a companion IV column. */
export function encryptToken(plaintext: string): string {
  const key = deriveKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export class InvalidEncryptedTokenError extends Error {
  constructor() {
    super("Stored token does not match the expected iv:authTag:ciphertext format.");
    this.name = "InvalidEncryptedTokenError";
  }
}

export function decryptToken(encrypted: string): string {
  const parts = encrypted.split(":");
  if (parts.length !== 3) throw new InvalidEncryptedTokenError();
  const [ivB64, authTagB64, ciphertextB64] = parts as [string, string, string];
  const key = deriveKey();
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextB64, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
