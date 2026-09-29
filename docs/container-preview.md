# LingLang container preview

**0.1.0-preview.1 · linux/amd64 · existing dashboard UI.**

This is an experimental self-hosting preview, not a production-ready voice release. The publishing workflow gates the image on a fresh account, authenticated API access, persistent sessions/user data and instance secrets after container recreation, on Docker and rootless Podman. It does not certify a complete tutor conversation or learning pipeline. No `latest` tag is published.

## Pull and run

After the version appears in the public package registry:

```sh
docker pull ghcr.io/coding-crying/linglang:0.1.0-preview.1
docker volume create linglang-data
docker run -d --name linglang --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  -v linglang-data:/data \
  ghcr.io/coding-crying/linglang:0.1.0-preview.1
```

For Podman, the same OCI image and named-volume layout apply:

```sh
podman pull ghcr.io/coding-crying/linglang:0.1.0-preview.1
podman volume create linglang-data
podman run -d --name linglang \
  -p 127.0.0.1:3000:3000 \
  -v linglang-data:/data \
  ghcr.io/coding-crying/linglang:0.1.0-preview.1
```

Open http://localhost:3000 and create an account using the signup page. Check startup with `docker logs linglang` or `podman logs linglang`. Rootless Podman startup-at-boot requires separate systemd/Quadlet configuration; it is not installed by this command.

Keep the named volume: it holds PostgreSQL and encryption/service secrets. Do not delete it or change generated secrets during recreation. Back up the volume before upgrades. External databases are an advanced, separately provisioned mode, not covered by these commands. Automatic upgrades from older experimental schemas are not supported.

## What is and is not ready

- Included: Node/dashboard, Python voice runtime, PostgreSQL 17 with pgvector, and the existing dashboard—not the experimental tree UI.
- Tested by the publishing workflow: cold Docker/Podman startup, signup, authenticated `/api/me`, and persisted user/session/secrets after recreation.
- Still experimental: provider onboarding, actual browser voice/media connectivity, full Pipecat learning-event processing and feature parity, external-database deployment, and upgrades. HTTP port mapping alone does not establish the WebRTC UDP/media path.
- Bind to localhost as shown. Do not expose this preview directly to the public internet: deployment-specific admin/auth hardening and a full security review remain outstanding. Use HTTPS for remote microphone access when the voice deployment is ready.
- Use your own provider credentials. No operator keys, local model servers or GPU models are bundled. External APIs may charge fees; using them sends relevant data to those providers.
- Budget 1 GB RAM for initial external-provider testing, not a guaranteed production minimum. Local AI models need additional RAM/VRAM. The earlier development image was approximately 2.2 GB; release size may differ.

## Reproducibility

The dedicated `release/container-preview` branch captures the current dashboard and required runtime source without modifying the dirty live checkout. Image labels identify the exact commit. The workflow also publishes `sha-<full-commit>` alongside the preview tag. Prefer a verified registry digest for pinned deployments.

The legacy development image omitted auxiliary SQL tables and failed fresh signup. Preview bootstrapping now includes the dashboard-session, conversation, alignment and retention tables in the same initial transaction. Only a new, owned embedded database is initialized; no production or external database is migrated.
