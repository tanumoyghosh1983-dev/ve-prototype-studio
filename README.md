# VE Prototype Studio — Gemini Edition

Prompt-to-prototype tool for VirtualEmployee.com mobile app prospects,
powered by Google's Gemini API instead of Claude or OpenAI.

## How it's structured

```
public/index.html                 → the frontend (what visitors see)
netlify/functions/generate.js     → serverless function that calls Gemini
netlify.toml                      → tells Netlify where things live
package.json                      → minimal, no external deps required
```

The frontend never talks to Gemini directly. It calls your own
`/.netlify/functions/generate` endpoint, which holds the real API key
server-side and proxies the request. A browser-side key would be
visible to anyone who views page source — this design prevents that.

## Deploy steps (Netlify)

1. **Get a Gemini API key** at [aistudio.google.com](https://aistudio.google.com):
   sign in → "Get API key" → "Create API key". Google is mid-migration
   between two key formats — you may get a key starting `AIzaSy...`
   (older/standard) or `AQ.` (newer "auth key"). **Both work fine** with
   this code, since it authenticates via the `x-goog-api-key` header on
   Gemini's native endpoint, which accepts either format.

   ⚠️ Google has stated standard `AIza` keys will stop being accepted
   after September 2026 — auth keys (`AQ.`) are the forward-compatible
   format, so if you're offered one, that's expected and fine.

2. **Push this folder to a Git repo**, or use the Netlify CLI to deploy.

3. **In Netlify:** "Add new site" → "Import an existing project" → connect
   the repo. Build settings auto-detect from `netlify.toml` — no build
   command needed, this is static HTML plus one function.

4. **Set the API key as an environment variable** (critical step):
   Netlify site dashboard → Site configuration → Environment variables:
   - Key: `GEMINI_API_KEY`
   - Value: your key from step 1
   - Scopes: all (or at least "Functions")

   Redeploy after adding it (Deploys → Trigger deploy → Deploy site).

5. **Test it:** visit your Netlify URL, type a prompt, hit Generate.
   Check Netlify's function logs (Site → Functions → generate → real-time
   logs) if something fails — the browser gets a generic-ish message but
   the log shows the real cause.

## Cost note

Gemini's free tier (as of mid-2026) allows a limited number of requests
per day on the `gemini-2.5-flash` model this function uses — enough for
a demo tool with light prospect traffic, but Google's exact limits
change over time, so check the current quota on their pricing page
before relying on it for real traffic. If you exceed the daily free
quota, requests will start failing with a 429 error until the quota
resets — visitors would see the "couldn't generate" error message.

## Model used

This function calls `gemini-2.5-flash` — Google's fast, cheap tier,
well-suited to this structured-JSON-generation task. You can change the
model by editing the `model` constant near the top of
`netlify/functions/generate.js` if you want to try a different one
(e.g. `gemini-2.5-pro` for higher quality at higher cost/lower free-tier
limits).

## Local testing (optional)

With the Netlify CLI installed:
```
npm install -g netlify-cli
netlify dev
```
Needs a `.env` file with `GEMINI_API_KEY=AQ....` or `AIzaSy...` in the
project root (already gitignored).
