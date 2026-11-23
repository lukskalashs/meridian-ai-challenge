# AI Engineer Challenge — pack contents

Everything you need for the take-home. **Start with `BRIEF.md`.**

All data in this pack is **fictional** — the firm "Meridian Wealth", its people
and its model portfolios are invented. There is no real client or company data.

## What's in here (candidate-facing)

| File | What it is |
|------|-----------|
| **`BRIEF.md`** | The task. Read this first. |
| **`proposal-schema.md`** | The data-model spec — the shape your agent's output must match. |
| **`schema.json`** | The same contract, machine-readable (JSON Schema). |
| **`challenge-generator.html`** | The proposal tool. Open it in a browser — offline, no login. Your agent feeds it via `window.loadProposal(...)`. |
| **`sample-inputs/`** | Example adviser notes + a voice-note transcript, each paired with an `*-expected.json` reference output. |

## Try it in 60 seconds

1. Open `challenge-generator.html` in any modern browser.
2. Open dev tools (F12) → Console.
3. Run:
   ```js
   window.challenge.example();     // a fully-worked proposal
   window.challenge.models();      // the models you can pass to applyModel
   window.loadProposal({ clientName: "Test", applyModel: "balanced" });
   ```
4. Load a sample by pasting the contents of `sample-inputs/01-expected.json` into
   `window.loadProposal( … )` and watch it render. That's the target your agent
   is aiming at.

Then read `proposal-schema.md` and build the agent described in `BRIEF.md`.

## Run the proposal assistant

The local assistant accepts typed adviser notes, a pasted voice-note transcript,
or an uploaded audio file. Audio is transcribed on the local server with the
OpenAI audio-transcriptions API, then placed in the notes box for review before
the proposal is generated. Supported files are FLAC, M4A, MP3, MP4, MPEG, OGG,
WAV, or WebM, up to 20 MB. The assistant does not persist the audio or
transcript locally; audio is sent to OpenAI for transcription.

The assistant uses OpenAI Structured Outputs (`strict: true`) to create a
proposal draft. The reviewer can edit familiar labeled fields and the
underlying proposal JSON before calling `window.loadProposal(...)` in the
supplied generator.

The assistant makes one extraction request using a fixed strict response schema
derived from the full proposal contract. Fields remain optional in the final
proposal, so the model should include only details supported by the notes. The
live generator model list constrains available model IDs. The model does not
design or select a new schema for each request.

The reviewer can edit friendly fields or the underlying JSON before loading.
Known dropdown values such as risk profile and investment horizon use a
conservative prefix match; unmatched values remain available for manual review.

Requirements: Node.js 18 or newer and an OpenAI API key with API access enabled.
The key is read by the local server and is never sent to the browser.

In PowerShell, from this folder:

```powershell
$env:OPENAI_API_KEY = "your-api-key"
node server.js
```

Then open `http://127.0.0.1:3000`. To select a different OpenAI model, set
`OPENAI_MODEL` before starting the server; it must support Structured Outputs.
The default is `gpt-4o-mini`. Audio transcription defaults to `whisper-1`; set
`OPENAI_TRANSCRIPTION_MODEL` before starting the server to choose another
compatible transcription model.

### WhatsApp Sandbox (Twilio)

The optional Twilio webhook accepts authorized WhatsApp text or one audio
voice note and runs the same extraction pipeline (transcribing audio first).
For this prototype, it does not send outbound WhatsApp messages: the resulting
proposal JSON, missing-information flags, and review notes are printed in the
server terminal. WhatsApp currently uses the three stable shared models only.
Use synthetic test notes because the generated proposal is visible in the
terminal.

1. Join and configure the Twilio WhatsApp Sandbox.
2. Expose local port 3000 through an HTTPS tunnel such as ngrok or Cloudflare
   Tunnel.
3. Configure these values in the PowerShell session that starts the server.
   The API Key SID and secret are needed to download voice-note media; create a
   Standard API Key in Twilio Console under **Account → API keys & tokens**.
   Keep credentials out of source control and chat:

   ```powershell
   $env:TWILIO_ACCOUNT_SID = "your-account-sid"
   $env:TWILIO_AUTH_TOKEN = "your-auth-token"
   $env:TWILIO_API_KEY_SID = "SK..."
   $env:TWILIO_API_KEY_SECRET = "your-api-key-secret"
   $env:TWILIO_WEBHOOK_URL = "https://your-public-host/api/whatsapp/inbound"
   $env:WHATSAPP_ALLOWED_SENDERS = "whatsapp:+15551234567"
   ```

4. In the Twilio Sandbox configuration, set the inbound message webhook to the
   exact `TWILIO_WEBHOOK_URL` above and select `POST`.
5. Start `node server.js`. The handler verifies Twilio's request signature and
   rejects senders not in `WHATSAPP_ALLOWED_SENDERS`.

The sender allowlist is required; list authorized WhatsApp sender IDs in the
same `whatsapp:+<country-code-and-number>` form Twilio sends. Never expose the
webhook without the Twilio signature and sender checks enabled.

Testing status: inbound WhatsApp text was exercised and generated a synthetic
draft in the server terminal. The current Sandbox voice-note test receives
HTTP 401 while downloading Twilio media, so that path is implemented but not
verified end to end. The Standard API Key must belong to the account that owns
the account SID in the media URL; this is separate from the webhook Auth Token.

The assistant loads a generator instance served from localhost. Browser storage
is separated by origin, so proposals or custom models saved when opening the
HTML directly with `file:///` will not automatically appear in this localhost
instance. Create or select custom models in the generator embedded in the
assistant.

## What I'd do next

I would complete and retest Twilio voice-media authentication, then add a
supported outbound WhatsApp response flow and exercise real uploaded audio.
Next, I would expand ambiguity tests and reconcile proposal fields that the
generator does not currently display, while keeping uncertain values visible
for reviewer confirmation.

Run the local checks with:

```powershell
node --test server.test.js
```
