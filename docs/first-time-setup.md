# First-time setup

LingLang is a voice-first language tutor. This guide separates using the hosted dashboard from the **experimental all-in-one self-hosted build**. They are not yet interchangeable.

## Use the hosted dashboard

1. Open [the dashboard](https://dashboard.linglang.app) and sign in with an account provided by the operator. If you do not have an account, ask the operator to create one; do not assume there is public self-registration.
2. Choose your native and target languages. Complete the available onboarding questions honestly—being a beginner is fine.
3. Open **Profile** to configure your providers, if the deployment permits changes.
4. Open **Voice**, allow microphone access, and start a conversation. Use headphones if the tutor hears its own audio. If your browser blocks sound, use the displayed playback control or interact with the page and retry.

### Bring your own Google key

Use the Google API key settings in Profile, and enable the Gemini realtime option when available. A key alone does not necessarily select realtime mode. Your Google account must have access to the configured model; billing, quota and regional restrictions can still reject a valid key.

Set spending limits with your provider. Never paste an API key into a conversation, issue, screenshot or public repository. Do not share a provider key between people unless you intend to pay for their usage.

### Bring separate LLM, STT and TTS services

In Profile's provider settings, configure each service's endpoint, model and credentials:

- **LLM:** generates the tutor's responses.
- **STT:** transcribes your speech.
- **TTS:** produces the tutor's spoken audio; select a supported voice too.

Disable Gemini realtime when you intend to use the separate-service path. The experimental Pipecat cascade uses OpenAI-compatible services; not every API that calls itself compatible implements the required speech or streaming endpoints. Test your actual providers before relying on them.

Provider requests originate from the server. An endpoint at `localhost` therefore means the server—or the container—not your laptop. Use an address reachable from the running service. Keep authentication enabled on externally reachable endpoints.

If Profile says providers are managed by the deployment, that is intentional: the operator controls these settings. Contact the operator instead of trying to bypass the restriction.

## Self-hosting: current release status

**The all-in-one Pipecat edition is a developer preview, not a supported first-time installation yet. There is no published, versioned all-in-one image to pull.** Do not substitute an invented Docker Hub or GHCR image name.

A local Linux image containing the dashboard, Node backend, Python/Pipecat and optional PostgreSQL/pgvector has passed fresh-start and restart checks. The dashboard and Pipecat HTTP endpoints responded successfully; generated secrets and the PostgreSQL cluster survived restart.

Those checks do **not** establish a complete learner experience. Remaining release gates include:

- Safe first-administrator provisioning for an empty database.
- Complete auxiliary database schema installation.
- Browser microphone/speaker tests through the actual container network.
- Transcript processing through the learning and progress pipeline.
- External-database and deployment-policy installation tests.
- A reviewed source release and versioned registry image.

The preview currently reaches a login page without provisioning its first account. **Stop there rather than inserting guessed accounts or using default passwords.** A successful health check is not a finished installation.

The existing repository also contains a separate legacy LiveKit deployment. Its requirements and Compose file are not the all-in-one Pipecat instructions. Do not mix the two configurations.

## Preview operator configuration reference

These settings describe the in-development all-in-one implementation; they are not a promise that the preview packaging is already available on the default GitHub branch.

### User-managed providers

`LINGLANG_PROVIDER_POLICY=user` permits each learner to configure their own supported providers through Profile. This is the default policy.

### Deployment-managed providers

`LINGLANG_PROVIDER_POLICY=deployment` locks provider edits in the UI and enforces that restriction on the backend.

For Google realtime, configure `SERVICE_MODE=gemini` and the server's `GEMINI_API_KEY`. For the separate-service path, use `SERVICE_MODE=cloud` with:

- `LINGLANG_LLM_URL`, `LINGLANG_LLM_MODEL`, `LINGLANG_LLM_API_KEY`
- `LINGLANG_STT_URL`, `LINGLANG_STT_MODEL`, `LINGLANG_STT_API_KEY`
- `LINGLANG_TTS_URL`, `LINGLANG_TTS_MODEL`, `LINGLANG_TTS_API_KEY`
- `LINGLANG_TTS_VOICE`

Put credentials in private runtime configuration, not in a committed Compose file. Do not assume that changing the policy migrates or deletes previously stored user settings.

### Database and persistent storage

The preview uses an embedded database when `DATABASE_URL` is empty. A nonempty value selects an external PostgreSQL database that must already have the product and voice schemas. It does not automatically migrate an existing external database.

Persist `/data`. It contains the embedded database, application data and generated encryption/service secrets. Back up the database **and** the secrets together. A filesystem copy of a running PostgreSQL data directory is not a reliable backup; use a consistent database backup or stop the container before copying the complete volume. Test restoration into a separate volume.

Do not delete the volume to troubleshoot startup. Do not rotate the encryption secret casually: stored provider credentials depend on it. The preview rejects configured secrets that conflict with its persisted values.

### Networking and microphone access

The preview's HTTP mapping is loopback-only by default. Remote browser microphone access requires HTTPS (localhost is the usual development exception).

Publishing the dashboard's TCP port is **not enough** to prove WebRTC media works. ICE/UDP reachability, NAT and possibly TURN must be configured and tested. Do not expose the private Pipecat runner or database port as a workaround.

## Troubleshooting

- **Login page works, but I cannot create an account:** hosted users need an operator-provisioned account; preview self-hosting still lacks first-user setup.
- **Microphone unavailable:** check HTTPS, browser permissions, device selection and whether another application is using the device.
- **Tutor is silent:** check speaker playback, provider credentials/quota and the media network path. HTTP health checks do not test audio.
- **Provider controls are unavailable:** check whether deployment-managed policy is enabled.
- **Local provider cannot be reached:** check connectivity from inside the server/container, not only from your browser.
- **Preview starts but logs `model_alignment_jobs` missing:** this is a known incomplete-schema gate, not proof of successful installation.
- **Transcript exists but progress does not update:** the Pipecat learning-processing path is still a release gate; transcript acceptance alone does not mean mastery was updated.

When reporting a problem, include the version/commit, provider mode, browser, expected behavior and redacted logs. Remove keys, cookies, connection strings, learner transcripts and other personal data.

[Project source and issues](https://github.com/coding-crying/LingLang) · [Website](https://linglang.app)
