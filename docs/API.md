# SH Lamp Cloud REST API — Phase 3A

Base URL after deployment: `https://YOUR-SERVICE.onrender.com`

All successful responses include `"ok": true`. Protected endpoints require:

```http
Authorization: Bearer ACCESS_TOKEN
```

## Health

- `GET /health`

## Authentication

- `POST /api/auth/register`
  ```json
  {"email":"owner@example.com","password":"StrongPass123","displayName":"Ankit"}
  ```
- `POST /api/auth/login`
  ```json
  {"email":"owner@example.com","password":"StrongPass123"}
  ```
- `POST /api/auth/refresh`
  ```json
  {"refreshToken":"..."}
  ```
- `POST /api/auth/logout`
  ```json
  {"refreshToken":"..."}
  ```
- `GET /api/me`

## Homes and rooms

- `GET /api/homes`
- `POST /api/homes` — `{"name":"Office"}`
- `GET /api/homes/:homeId`
- `POST /api/homes/:homeId/rooms` — `{"name":"Living Room"}`

## Test-device registration

Admin-only manufacturing simulation:

- `POST /api/admin/devices`
- Header: `x-admin-key: ADMIN_SETUP_KEY`
- Body:
  ```json
  {"lampId":"SH-A31F92","displayName":"Test Lamp","firmwareVersion":"R9-TEST"}
  ```

The response contains `deviceSecret` and `claimCode` exactly once. Save both.

## Lamp management

- `POST /api/devices/claim`
  ```json
  {
    "lampId":"SH-A31F92",
    "claimCode":"ABCD2345",
    "homeId":"HOME_UUID",
    "roomId":null,
    "displayName":"Living Room Lamp"
  }
  ```
- `GET /api/devices`
- `GET /api/devices/:lampId/state`
- `PATCH /api/devices/:lampId`
  ```json
  {"displayName":"Bedside Lamp","roomId":"ROOM_UUID"}
  ```
- `POST /api/devices/:lampId/commands`
  ```json
  {"action":"setBrightness","value":70}
  ```
- `DELETE /api/devices/:lampId` — releases ownership and returns a new claim code.

Allowed actions: `toggle`, `setPower`, `setBrightness`, `setFadeMode`, `setTimer`, `identify`, `requestState`.
