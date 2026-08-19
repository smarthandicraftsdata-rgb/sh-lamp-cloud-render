import {
  randomChallengeMaterial,
  SH_AUTH_CHALLENGE_TTL_MS,
  SH_AUTH_PROTOCOL,
  type AuthV2Challenge
} from "./shadowAuth";

type ChallengeRecord = {
  challengeIdHex: string;
  nonce: Buffer;
  canonicalDeviceId: string;
  legacyDeviceDbId: string;
  keyVersion: number;
  socketGeneration: number;
  expiresAtMs: number;
};

export type ChallengeTakeResult =
  | { kind: "ok"; record: ChallengeRecord }
  | { kind: "expired" }
  | { kind: "used" }
  | { kind: "missing" };

export class ShadowChallengeStore {
  private readonly byChallengeId = new Map<string, ChallengeRecord>();
  private readonly activeBySocketDevice = new Map<string, string>();
  private readonly consumedUntil = new Map<string, number>();

  private socketDeviceKey(socketGeneration: number, legacyDeviceDbId: string): string {
    return `${socketGeneration}:${legacyDeviceDbId}`;
  }

  create(
    canonicalDeviceId: string,
    legacyDeviceDbId: string,
    keyVersion: number,
    socketGeneration: number,
    nowMs = Date.now()
  ): AuthV2Challenge {
    this.deleteForSocketDevice(socketGeneration, legacyDeviceDbId, nowMs);
    this.sweep(nowMs);

    const { challengeId, nonce } = randomChallengeMaterial();
    const challengeIdHex = challengeId.toString("hex");
    const record: ChallengeRecord = {
      challengeIdHex,
      nonce,
      canonicalDeviceId,
      legacyDeviceDbId,
      keyVersion,
      socketGeneration,
      expiresAtMs: nowMs + SH_AUTH_CHALLENGE_TTL_MS
    };

    this.byChallengeId.set(challengeIdHex, record);
    this.activeBySocketDevice.set(this.socketDeviceKey(socketGeneration, legacyDeviceDbId), challengeIdHex);
    return {
      type: "authV2Challenge",
      protocol: SH_AUTH_PROTOCOL,
      deviceId: canonicalDeviceId,
      keyVersion,
      challengeId: challengeIdHex,
      nonce: nonce.toString("hex"),
      expiresInMs: SH_AUTH_CHALLENGE_TTL_MS,
      shadowOnly: true
    };
  }

  take(challengeIdHex: string, nowMs = Date.now()): ChallengeTakeResult {
    this.sweepConsumed(nowMs);
    const record = this.byChallengeId.get(challengeIdHex);
    if (!record) return this.consumedUntil.has(challengeIdHex) ? { kind: "used" } : { kind: "missing" };

    this.byChallengeId.delete(challengeIdHex);
    this.activeBySocketDevice.delete(this.socketDeviceKey(record.socketGeneration, record.legacyDeviceDbId));
    this.consumedUntil.set(challengeIdHex, nowMs + SH_AUTH_CHALLENGE_TTL_MS);

    if (record.expiresAtMs < nowMs) {
      record.nonce.fill(0);
      return { kind: "expired" };
    }
    return { kind: "ok", record };
  }

  deleteForSocketDevice(socketGeneration: number, legacyDeviceDbId: string, nowMs = Date.now()): void {
    const key = this.socketDeviceKey(socketGeneration, legacyDeviceDbId);
    const challengeId = this.activeBySocketDevice.get(key);
    if (!challengeId) return;
    this.activeBySocketDevice.delete(key);
    const record = this.byChallengeId.get(challengeId);
    if (record) record.nonce.fill(0);
    this.byChallengeId.delete(challengeId);
    this.consumedUntil.set(challengeId, nowMs + SH_AUTH_CHALLENGE_TTL_MS);
  }

  deleteForSocket(socketGeneration: number, legacyDeviceDbId: string, nowMs = Date.now()): void {
    this.deleteForSocketDevice(socketGeneration, legacyDeviceDbId, nowMs);
    this.sweepConsumed(nowMs);
  }

  private sweep(nowMs = Date.now()): void {
    for (const [challengeId, record] of this.byChallengeId) {
      if (record.expiresAtMs >= nowMs) continue;
      record.nonce.fill(0);
      this.byChallengeId.delete(challengeId);
      this.activeBySocketDevice.delete(this.socketDeviceKey(record.socketGeneration, record.legacyDeviceDbId));
    }
    this.sweepConsumed(nowMs);
  }

  private sweepConsumed(nowMs: number): void {
    for (const [challengeId, expiresAt] of this.consumedUntil) {
      if (expiresAt < nowMs) this.consumedUntil.delete(challengeId);
    }
  }
}
