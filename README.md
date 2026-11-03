# Morning Eyes + Oura

This prototype can read your Oura daily sleep score and ask how you feel across a few life dimensions. Oura is optional; the page still works as an eyes-and-voice demo without it.

## Run and connect

This version uses a small Node service because Oura does not allow this page to read its API directly from a browser origin. It uses Oura's OAuth authorization-code flow with PKCE, and keeps the client secret and access/refresh tokens on the server.

1. Host this folder behind HTTPS on a service that can run Node.js 18 or later. The iPhone should open the hosted HTTPS page. A static HTML host alone is not enough.
2. In Oura Cloud, create an API application with the `daily` scope. Register `https://your-domain.example/oauth/callback` as its redirect URI, using your actual domain.
3. Copy `.env.example` to `.env` in your hosting environment and fill in `BASE_URL`, `OURA_CLIENT_ID`, and `OURA_CLIENT_SECRET`. Keep `.env` private and out of source control.
4. Start the service with `node server.js`. Open its HTTPS address and tap **Connect Oura**.

The small Node service is intentionally single-user for this prototype. Oura tokens stay in server memory and disappear if the process restarts, so you will need to reconnect after a restart. The browser receives only a secure, HTTP-only session cookie. Feeling selections are saved only in this browser's `localStorage`; they are not sent to the service. The page opens with a check-in when connected, and its existing `morningEyes.wake()` hook also refreshes Oura data when a sleep-state screen wakes.

The score is a conversation prompt, not a measure of how the person should feel. Check-ins let the user choose body, work, relationships, or life overall, then record good, tired, or unsure.
