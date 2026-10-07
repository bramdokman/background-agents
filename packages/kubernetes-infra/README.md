# OpenInspect Kubernetes Image Tooling

Builds the OCI image that Open-Inspect Kubernetes sandboxes run. The control plane talks to the
Kubernetes API directly at runtime; this package only builds the image. Deployment, isolation and
operations are in [docs/KUBERNETES_SANDBOX_PROVIDER.md](../../docs/KUBERNETES_SANDBOX_PROVIDER.md).

## What's here

- **[Shared image package](../sandbox-images/README.md)** — owns the substrate, dependency pins,
  frozen installation bundle, runtime wheel, and verification.
- **`build-image.py`** — stages the shared bundle, builds an ordinary OCI image with any Docker
  daemon (the shared installation, the runtime env as `ENV`, the pinned runtime uid as `USER`, the
  runtime entrypoint), then runs `smoke_test.py verify` in a fresh container of it. It uses only the
  Python standard library and the `docker` CLI, so it has no `pyproject.toml` of its own.

The image runs nothing of its own beyond the runtime supervisor. The provider starts every pod with
the session env from a per-sandbox Secret, so one image serves every session.

## Build

Use the repository-root build command:

```bash
export KUBERNETES_SANDBOX_IMAGE_REPOSITORY=registry.example.com/open-inspect-sandbox
export KUBERNETES_VERIFY_RUNTIME=runsc     # optional: verify under gVisor, as it will run
export KUBERNETES_IMAGE_PUSH=true          # optional: push and return the digest reference
npm run sandbox:images -- build --provider kubernetes --output /tmp/kubernetes-image.json
# Output is {"reference":"<repository>@sha256:..."} when pushed, else the local tag.
```

`DOCKER_HOST` selects the daemon (for example `ssh://root@build-host`);
`OPENINSPECT_IMAGE_CANDIDATE` sets an explicit tag in place of the build hash.

Then set `KUBERNETES_SANDBOX_IMAGE` on the control plane and the admission policy's `sandboxImages`
to the same reference. List both the old and the new reference while sessions on the old image may
still resume.
