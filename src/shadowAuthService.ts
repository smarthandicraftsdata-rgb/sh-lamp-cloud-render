import { ShadowChallengeStore } from "./shadowChallengeStore";
import { PrismaShadowAuthRepository, type ShadowCredentialMetadataResult } from "./shadowAuthRepository";
import {
  authV2HelloSchema,
  authV2ProofSchema,
  buildShAuthV1Message,
  computeShAuthV1Proof,
  shadowResult,
  SH_AUTH_PROTOCOL,
  verifyShAuthV1Proof,
  type AuthV2Challenge,
  type AuthV2ShadowCode,
  type AuthV2ShadowResult
} from "./shadowAuth";
import { config } from "./config";

type ShadowSocketContext = {
  socketGeneration: number;
  legacyDeviceDbId: string;
  lampId: string;
};

function metadataCode(result: Exclude<ShadowCredentialMetadataResult, { kind: "ok" }>): AuthV2ShadowCode {
  switch (result.kind) {
    case "unknown_device": return "UNKNOWN_DEVICE";
    case "device_mismatch": return "DEVICE_MISMATCH";
    case "key_version_mismatch": return "KEY_VERSION_MISMATCH";
    case "credential_unavailable": return "CREDENTIAL_UNAVAILABLE";
  }
}

export class ShadowAuthService {
  private readonly challenges = new ShadowChallengeStore();
  private readonly repository = new PrismaShadowAuthRepository();

  async handleHello(raw: unknown, context: ShadowSocketContext): Promise<AuthV2Challenge | AuthV2ShadowResult> {
    const parsed = authV2HelloSchema.safeParse(raw);
    if (!parsed.success) return shadowResult("", 1, false, "INVALID_REQUEST");
    const hello = parsed.data;
    if (!config.shadowAuthEnabled || !config.deviceCredentialMasterKey) {
      return shadowResult(hello.deviceId, hello.keyVersion, false, "DISABLED");
    }

    const metadata = await this.repository.getCredentialMetadata(
      context.legacyDeviceDbId,
      hello.deviceId,
      hello.keyVersion
    );
    if (metadata.kind !== "ok") {
      const code = metadataCode(metadata);
      console.warn(`RF7 P2B shadow hello rejected lamp=${context.lampId} deviceId=${hello.deviceId} keyVersion=${hello.keyVersion} code=${code}`);
      return shadowResult(hello.deviceId, hello.keyVersion, false, code);
    }

    const challenge = this.challenges.create(
      hello.deviceId,
      context.legacyDeviceDbId,
      hello.keyVersion,
      context.socketGeneration
    );
    console.log(`RF7 P2B shadow challenge lamp=${context.lampId} deviceId=${hello.deviceId} keyVersion=${hello.keyVersion} generation=${context.socketGeneration}`);
    return challenge;
  }

  async handleProof(raw: unknown, context: ShadowSocketContext): Promise<AuthV2ShadowResult> {
    const parsed = authV2ProofSchema.safeParse(raw);
    if (!parsed.success) return shadowResult("", 1, false, "INVALID_REQUEST");
    const proof = parsed.data;
    if (!config.shadowAuthEnabled || !config.deviceCredentialMasterKey) {
      return shadowResult(proof.deviceId, proof.keyVersion, false, "DISABLED");
    }

    const taken = this.challenges.take(proof.challengeId);
    if (taken.kind === "expired") return shadowResult(proof.deviceId, proof.keyVersion, false, "CHALLENGE_EXPIRED");
    if (taken.kind === "used") return shadowResult(proof.deviceId, proof.keyVersion, false, "CHALLENGE_ALREADY_USED");
    if (taken.kind === "missing") return shadowResult(proof.deviceId, proof.keyVersion, false, "CHALLENGE_INVALID");

    const challenge = taken.record;
    try {
      if (challenge.canonicalDeviceId !== proof.deviceId ||
          challenge.legacyDeviceDbId !== context.legacyDeviceDbId ||
          challenge.keyVersion !== proof.keyVersion ||
          challenge.socketGeneration !== context.socketGeneration) {
        return shadowResult(proof.deviceId, proof.keyVersion, false, "CHALLENGE_INVALID");
      }

      const loaded = await this.repository.loadCredentialSecret(
        context.legacyDeviceDbId,
        proof.deviceId,
        proof.keyVersion
      );
      if (loaded.kind !== "ok") return shadowResult(proof.deviceId, proof.keyVersion, false, metadataCode(loaded));

      let expected: Buffer | undefined;
      let message: Buffer | undefined;
      let ok = false;
      try {
        message = buildShAuthV1Message(proof.deviceId, Buffer.from(proof.challengeId, "hex"), challenge.nonce);
        expected = computeShAuthV1Proof(loaded.secret, message);
        ok = verifyShAuthV1Proof(expected, proof.proof);
      } finally {
        loaded.secret.fill(0);
        expected?.fill(0);
        message?.fill(0);
      }

      console.log(`RF7 P2B shadow result lamp=${context.lampId} deviceId=${proof.deviceId} keyVersion=${proof.keyVersion} generation=${context.socketGeneration} ok=${ok}`);
      return shadowResult(proof.deviceId, proof.keyVersion, ok, ok ? "OK" : "INVALID_PROOF");
    } finally {
      challenge.nonce.fill(0);
    }
  }

  onSocketClosed(socketGeneration: number, legacyDeviceDbId: string): void {
    this.challenges.deleteForSocket(socketGeneration, legacyDeviceDbId);
  }
}

export function shadowAuthProtocolInfo(): { protocol: string; enabled: boolean; shadowOnly: true } {
  return { protocol: SH_AUTH_PROTOCOL, enabled: config.shadowAuthEnabled, shadowOnly: true };
}
