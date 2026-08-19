# SH-AUTH-V1 shadow authentication

## Canonical HMAC message

Exactly 75 bytes:

| Field | Bytes |
|---|---:|
| ASCII `SH-AUTH-V1` | 10 |
| separator `0x00` | 1 |
| UUIDv4 raw bytes | 16 |
| challengeId raw bytes | 16 |
| nonce raw bytes | 32 |

Proof is `HMAC-SHA256(deviceCredential, message)` and is transported as 64 lowercase hexadecimal characters.

Public cross-platform test vector:

- key: bytes `00..1f`
- UUID: `719a68b7-1366-4c5c-9702-cba7c1c6085a`
- challengeId: bytes `00..0f`
- nonce: bytes `20..3f`
- expected proof: `3b50437746a3b4f808a07fd08a081c584d5cbcfdcb815a3904e78e10c586554c`

## WebSocket messages

Device sends after legacy auth:

```json
{"type":"authV2Hello","protocol":"SH-AUTH-V1","deviceId":"...","keyVersion":1}
```

Server replies:

```json
{"type":"authV2Challenge","protocol":"SH-AUTH-V1","deviceId":"...","keyVersion":1,"challengeId":"<32 hex>","nonce":"<64 hex>","expiresInMs":30000,"shadowOnly":true}
```

Device returns:

```json
{"type":"authV2Proof","protocol":"SH-AUTH-V1","deviceId":"...","keyVersion":1,"challengeId":"<32 hex>","proof":"<64 hex>"}
```

Server returns a shadow-only result. This result never changes current socket authority in P2B.

Challenges are one-time, expire after 30 seconds, are bound to the canonical UUID, existing database Device row and exact WebSocket generation, and are destroyed when that socket generation closes.
