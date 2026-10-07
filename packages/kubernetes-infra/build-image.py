#!/usr/bin/env python3
"""Build and verify the Kubernetes sandbox image from the provider-neutral bundle.

The image is an ordinary OCI image: the shared installation, the runtime
environment baked as ENV, the pinned runtime uid as USER, and the runtime
entrypoint. Verification runs ``smoke_test.py verify`` in a fresh container of
the built image, under the gVisor runtime when ``KUBERNETES_VERIFY_RUNTIME``
names one (``runsc``), so the artifact is checked on the isolation it ships for.

Environment:
  KUBERNETES_SANDBOX_IMAGE_REPOSITORY  image name without tag (required)
  KUBERNETES_IMAGE_PUSH                "true" pushes and returns the digest reference
  KUBERNETES_VERIFY_RUNTIME            docker --runtime for verification (e.g. runsc)
  OPENINSPECT_IMAGE_CANDIDATE          explicit tag, in place of the build hash
  DOCKER_HOST                          any Docker daemon, e.g. ssh://root@build-host
"""

from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "packages/sandbox-images/src"))

from sandbox_images.bundle import pack_bundle  # noqa: E402
from sandbox_images.native import write_build_result  # noqa: E402

ENTRYPOINT = ["/opt/openinspect/python/bin/python", "-m", "sandbox_runtime.entrypoint"]
VERIFY_COMMAND = ["/opt/openinspect/python/bin/python", "/app/verify/smoke_test.py", "verify"]


def render_dockerfile(plan: dict) -> str:
    """Layer the install phases as the reference Dockerfile does, for cache reuse."""
    target = plan["target"]
    if "uid" not in target:
        raise ValueError("The kubernetes image target must pin a numeric uid")
    install = "/tmp/openinspect-image/packages/sandbox-images/install"
    env = plan["runtimeEnv"] | {"SANDBOX_VERSION": plan["runtimeVersion"]}
    lines = [
        f"FROM {target['base']}",
        "COPY image-config.sh /tmp/openinspect-image/image-config.sh",
        "COPY packages/sandbox-images/install/install.sh "
        f"packages/sandbox-images/install/common.sh {install}/",
        f"COPY packages/sandbox-images/install/os {install}/os",
        f"RUN bash {install}/install.sh os",
        f"COPY packages/sandbox-images/install/languages.sh {install}/languages.sh",
        f"RUN bash {install}/install.sh languages",
        "COPY packages/sandbox-images/locks/tools "
        "/tmp/openinspect-image/packages/sandbox-images/locks/tools",
        "COPY packages/sandbox-images/locks/plugins "
        "/tmp/openinspect-image/packages/sandbox-images/locks/plugins",
        f"COPY packages/sandbox-images/install/tools.sh {install}/tools.sh",
        f"RUN bash {install}/install.sh tools",
        "COPY . /tmp/openinspect-image",
        f"RUN bash {install}/install.sh runtime filesystem "
        "&& /opt/openinspect/python/bin/python "
        "/tmp/openinspect-image/packages/sandbox-images/verify/smoke_test.py install "
        "&& rm -rf /tmp/openinspect-image",
        *(f"ENV {key}={json.dumps(value)}" for key, value in sorted(env.items())),
        f"USER {target['uid']}:{target['uid']}",
        "WORKDIR /workspace",
        f"ENTRYPOINT {json.dumps(ENTRYPOINT)}",
    ]
    return "\n".join(lines) + "\n"


def run(command: list[str], **kwargs) -> subprocess.CompletedProcess:
    print("+ " + shlex.join(command), flush=True)
    return subprocess.run(command, check=True, **kwargs)


def main() -> None:
    repository = os.environ.get("KUBERNETES_SANDBOX_IMAGE_REPOSITORY", "").strip()
    if not repository:
        raise RuntimeError("KUBERNETES_SANDBOX_IMAGE_REPOSITORY is required")
    bundle = pack_bundle(ROOT, "kubernetes", ROOT / ".cache/sandbox-images")
    plan = bundle.plan
    tag = os.environ.get("OPENINSPECT_IMAGE_CANDIDATE") or plan["buildHash"][:12]
    reference = f"{repository}:{tag}"
    dockerfile = bundle.directory / "Dockerfile.kubernetes"
    dockerfile.write_text(render_dockerfile(plan))
    run(
        [
            "docker",
            "build",
            "--platform",
            "linux/amd64",
            "-f",
            str(dockerfile),
            "-t",
            reference,
            str(bundle.directory),
        ]
    )

    verify = ["docker", "run", "--rm", "--user", "0", "--entrypoint", VERIFY_COMMAND[0]]
    runtime = os.environ.get("KUBERNETES_VERIFY_RUNTIME", "").strip()
    if runtime:
        verify += ["--runtime", runtime]
    result = subprocess.run([*verify, reference, *VERIFY_COMMAND[1:]], check=False)
    if result.returncode != 0:
        raise RuntimeError(f"Kubernetes sandbox image verification failed for {reference}")

    if os.environ.get("KUBERNETES_IMAGE_PUSH", "").strip().lower() == "true":
        run(["docker", "push", reference])
        digests = run(
            ["docker", "image", "inspect", "--format", "{{json .RepoDigests}}", reference],
            capture_output=True,
            text=True,
        )
        pinned = [d for d in json.loads(digests.stdout) if d.startswith(f"{repository}@")]
        if not pinned:
            raise RuntimeError(f"Pushed image has no digest for {repository}")
        write_build_result(pinned[0])
    else:
        # Not pushed: the tag is the reference an operator imports into the
        # node's image store (e.g. `k3s ctr images import`).
        write_build_result(reference)


if __name__ == "__main__":
    main()
