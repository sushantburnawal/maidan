Implement an `auth` module in apps/api. Phone-number-first OTP login (no passwords).

Flow:
- POST /auth/request-otp { phone }  -> generate 6-digit OTP, store in Redis key otp:<phone> with
  120s TTL and an attempt counter; send via MSG91 (wrap MSG91 behind an SmsProvider interface so it
  can be stubbed in tests). Rate-limit per phone (e.g. max 5/hour) using Redis.
- POST /auth/verify-otp { phone, code } -> verify+consume OTP. On first success, create a profiles
  row. Issue access JWT (15m) + refresh JWT (30d, rotating, stored hashed in Redis).
- POST /auth/refresh { refreshToken } -> rotate.
- A JwtAuthGuard + @CurrentUser() decorator exposing the profile id for downstream modules.

Constraints:
- Use the service-role DB connection for the API (RLS bypass) but still scope every query by the
  authenticated profile id in code.
- SmsProvider has a FakeSmsProvider used in tests and when MSG91_API_KEY is unset (logs the OTP).

DoD: e2e test covers request→verify→access protected route→refresh→old refresh rejected. OTP never
appears in any response body.