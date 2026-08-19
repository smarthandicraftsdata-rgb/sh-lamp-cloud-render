import { prisma } from "./db";
import { config } from "./config";
import { decryptDeviceSecret, type EncryptedDeviceSecret } from "./credentialEnvelope";
import { SH_AUTH_PROTOCOL } from "./shadowAuth";

export type ShadowCredentialMetadataResult =
  | { kind: "ok"; status: string }
  | { kind: "unknown_device" }
  | { kind: "device_mismatch" }
  | { kind: "key_version_mismatch" }
  | { kind: "credential_unavailable" };

export type LoadedShadowSecretResult =
  | { kind: "ok"; secret: Buffer }
  | Exclude<ShadowCredentialMetadataResult, { kind: "ok" }>;

export class PrismaShadowAuthRepository {
  async getCredentialMetadata(
    legacyDeviceDbId: string,
    canonicalDeviceId: string,
    keyVersion: number
  ): Promise<ShadowCredentialMetadataResult> {
    const byCanonical = await prisma.device.findUnique({
      where: { canonicalDeviceId },
      select: { id: true, identityProtocol: true, identityKeyVersion: true }
    });
    if (!byCanonical) return { kind: "unknown_device" };
    if (byCanonical.id !== legacyDeviceDbId) return { kind: "device_mismatch" };
    if (byCanonical.identityProtocol !== SH_AUTH_PROTOCOL || byCanonical.identityKeyVersion !== keyVersion) {
      return { kind: "key_version_mismatch" };
    }

    const credential = await prisma.deviceCredential.findUnique({
      where: {
        deviceId_protocol_keyVersion: {
          deviceId: legacyDeviceDbId,
          protocol: SH_AUTH_PROTOCOL,
          keyVersion
        }
      },
      select: { status: true, revokedAt: true }
    });
    if (!credential || credential.revokedAt || credential.status === "REVOKED") {
      return { kind: "credential_unavailable" };
    }
    return { kind: "ok", status: credential.status };
  }

  async loadCredentialSecret(
    legacyDeviceDbId: string,
    canonicalDeviceId: string,
    keyVersion: number
  ): Promise<LoadedShadowSecretResult> {
    const metadata = await this.getCredentialMetadata(legacyDeviceDbId, canonicalDeviceId, keyVersion);
    if (metadata.kind !== "ok") return metadata;
    if (!config.deviceCredentialMasterKey) return { kind: "credential_unavailable" };

    const credential = await prisma.deviceCredential.findUnique({
      where: {
        deviceId_protocol_keyVersion: {
          deviceId: legacyDeviceDbId,
          protocol: SH_AUTH_PROTOCOL,
          keyVersion
        }
      },
      select: {
        status: true,
        revokedAt: true,
        cipher: true,
        secretCiphertext: true,
        secretIv: true,
        secretAuthTag: true,
        wrappingKeyVersion: true
      }
    });
    if (!credential || credential.revokedAt || credential.status === "REVOKED" || credential.cipher !== "AES-256-GCM") {
      return { kind: "credential_unavailable" };
    }
    if (credential.wrappingKeyVersion !== config.deviceCredentialWrappingKeyVersion) {
      return { kind: "credential_unavailable" };
    }

    const encrypted: EncryptedDeviceSecret = {
      cipher: "AES-256-GCM",
      ciphertext: Buffer.from(credential.secretCiphertext),
      iv: Buffer.from(credential.secretIv),
      authTag: Buffer.from(credential.secretAuthTag)
    };
    const secret = decryptDeviceSecret(
      config.deviceCredentialMasterKey,
      legacyDeviceDbId,
      canonicalDeviceId,
      SH_AUTH_PROTOCOL,
      keyVersion,
      credential.wrappingKeyVersion,
      encrypted
    );
    if (secret.length !== 32) {
      secret.fill(0);
      return { kind: "credential_unavailable" };
    }
    return { kind: "ok", secret };
  }
}
