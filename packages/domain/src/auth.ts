import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * Password hashing via Node's built-in scrypt — no native-binding dependency (bcrypt/argon2
 * would need a compiled addon). Format: "scrypt:<saltHex>:<hashHex>".
 */
const KEY_LENGTH = 64;

function scryptAsync(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt);
  return `scrypt:${salt.toString("hex")}:${derived.toString("hex")}`;
}

export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  const [scheme, saltHex, hashHex] = storedHash.split(":");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;

  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scryptAsync(password, salt);

  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}
