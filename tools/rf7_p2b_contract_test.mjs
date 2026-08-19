import crypto from "node:crypto";
import assert from "node:assert/strict";

const protocol = Buffer.from("SH-AUTH-V1", "ascii");
const deviceId = "719a68b7-1366-4c5c-9702-cba7c1c6085a";
const uuid = Buffer.from(deviceId.replaceAll("-", ""), "hex");
const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
const challengeId = Buffer.from(Array.from({ length: 16 }, (_, i) => i));
const nonce = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 0x20));
const message = Buffer.concat([protocol, Buffer.from([0]), uuid, challengeId, nonce]);
assert.equal(message.length, 75);
const proof = crypto.createHmac("sha256", key).update(message).digest("hex");
assert.equal(proof, "3b50437746a3b4f808a07fd08a081c584d5cbcfdcb815a3904e78e10c586554c");

const master = crypto.randomBytes(32);
const devSecret = crypto.randomBytes(32);
const legacyDeviceDbId = "00000000-0000-4000-8000-000000000001";
const wrappingVersion = 1;
const aad = Buffer.from(`SH-CRED-V1|${legacyDeviceDbId}|${deviceId}|SH-AUTH-V1|1|${wrappingVersion}`, "utf8");
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv("aes-256-gcm", master, iv, { authTagLength: 16 });
cipher.setAAD(aad);
const ciphertext = Buffer.concat([cipher.update(devSecret), cipher.final()]);
const tag = cipher.getAuthTag();
const decipher = crypto.createDecipheriv("aes-256-gcm", master, iv, { authTagLength: 16 });
decipher.setAAD(aad);
decipher.setAuthTag(tag);
const roundTrip = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
assert.equal(roundTrip.equals(devSecret), true);

console.log("RF7 P2B protocol vector: PASS");
console.log("Canonical message bytes: 75");
console.log(`HMAC: ${proof}`);
console.log("AES-256-GCM credential envelope: PASS");
