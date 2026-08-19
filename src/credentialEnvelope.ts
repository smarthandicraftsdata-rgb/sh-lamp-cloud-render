import crypto from "node:crypto";

export type EncryptedDeviceSecret = {
  cipher: "AES-256-GCM";
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
};

function credentialAad(
  legacyDeviceDbId: string,
  canonicalDeviceId: string,
  protocol: string,
  keyVersion: number,
  wrappingKeyVersion: number
): Buffer {
  return Buffer.from(
    `SH-CRED-V1|${legacyDeviceDbId}|${canonicalDeviceId.toLowerCase()}|${protocol}|${keyVersion}|${wrappingKeyVersion}`,
    "utf8"
  );
}

export function decodeCredentialMasterKey(base64Value: string | undefined): Buffer | null {
  if (!base64Value) return null;
  const key = Buffer.from(base64Value.trim(), "base64");
  if (key.length !== 32) throw new Error("DEVICE_CREDENTIAL_MASTER_KEY_B64 must decode to exactly 32 bytes");
  return key;
}

export function encryptDeviceSecret(
  masterKey: Buffer,
  legacyDeviceDbId: string,
  canonicalDeviceId: string,
  protocol: string,
  keyVersion: number,
  wrappingKeyVersion: number,
  deviceSecret: Buffer
): EncryptedDeviceSecret {
  if (masterKey.length !== 32) throw new Error("MASTER_KEY_MUST_BE_32_BYTES");
  if (deviceSecret.length !== 32) throw new Error("DEVICE_SECRET_MUST_BE_32_BYTES");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey, iv, { authTagLength: 16 });
  cipher.setAAD(credentialAad(legacyDeviceDbId, canonicalDeviceId, protocol, keyVersion, wrappingKeyVersion));
  const ciphertext = Buffer.concat([cipher.update(deviceSecret), cipher.final()]);
  return { cipher: "AES-256-GCM", ciphertext, iv, authTag: cipher.getAuthTag() };
}

export function decryptDeviceSecret(
  masterKey: Buffer,
  legacyDeviceDbId: string,
  canonicalDeviceId: string,
  protocol: string,
  keyVersion: number,
  wrappingKeyVersion: number,
  encrypted: EncryptedDeviceSecret
): Buffer {
  if (masterKey.length !== 32) throw new Error("MASTER_KEY_MUST_BE_32_BYTES");
  const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey, encrypted.iv, { authTagLength: 16 });
  decipher.setAAD(credentialAad(legacyDeviceDbId, canonicalDeviceId, protocol, keyVersion, wrappingKeyVersion));
  decipher.setAuthTag(encrypted.authTag);
  return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]);
}
