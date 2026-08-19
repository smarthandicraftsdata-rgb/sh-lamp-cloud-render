# RF7 P2B — Render shadow-auth integration

This branch adds the server half of `SH-AUTH-V1` **without replacing the existing device authentication**.

## Safety lock

- Existing `{type:"auth", lampId, deviceSecret}` remains authoritative.
- `authV2Hello` / `authV2Proof` run only after legacy device authentication succeeds.
- A P2B PASS does **not** grant command authority.
- A P2B FAIL does **not** disconnect the device or mark it offline.
- SH-AUTH-V1 runs on a separate per-device promise lane so DB/decryption work cannot queue ahead of ACK/state handling.
- Existing Device, DeviceState, DeviceCommand and ownership data are not rewritten by the migration.

## Deployment order

1. Deploy this backend with `SHADOW_AUTH_ENABLED=false`.
2. Confirm Render migration/build/start succeeds and current lamp Cloud control still works.
3. Add `DEVICE_CREDENTIAL_MASTER_KEY_B64` in Render as a 32-byte random key encoded in base64.
4. Keep `SHADOW_AUTH_ENABLED=false` while provisioning the test credential.
5. Provision the P2A canonical UUID + development key through the admin endpoint.
6. Confirm returned `keyFingerprint` equals the ESP P2A fingerprint.
7. Set `SHADOW_AUTH_ENABLED=true`.
8. Only then build P2C firmware that sends `authV2Hello` / `authV2Proof`.

Generate a development wrapping key locally, for example:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Never commit that result to GitHub.

## Admin provisioning endpoint

`POST /api/admin/devices/:lampId/shadow-auth`

Header: existing `x-admin-key`.

Body:

```json
{
  "canonicalDeviceId": "719a68b7-1366-4c5c-9702-cba7c1c6085a",
  "keyVersion": 1,
  "authKeyHex": "<64 hex characters from the P2A development key>"
}
```

The response returns only a SHA-256 fingerprint of the key; the plaintext key is not stored or returned.

Status can be inspected with `GET /api/admin/devices/:lampId/shadow-auth` using the same admin header.
