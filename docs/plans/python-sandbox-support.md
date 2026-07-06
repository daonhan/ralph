# Plan: Python Support for ralph-sandbox

> Source PRD: [`docs/prd/python-sandbox-support.md`](../prd/python-sandbox-support.md)

## Architectural decisions

Durable decisions that apply across all phases. Touch these only with a follow-up PRD.

- **Scope of change**: this is a `ralph-sandbox` image feature. No changes to stage orchestration, template rendering, Docker-run argument construction, CLI parsing, or prompt playbooks.
- **Runtime contract**: the image exposes Debian Bookworm's system Python as both `python3` and `python`. Python 3 is the only supported Python line.
- **Environment contract**: `python -m venv` works for project-local virtual environments. Project dependencies belong in a virtual environment or isolated tool-managed location, not in system Python.
- **Package tooling**: include at least one modern Python package runner/installer that works for the non-root `agent` user in non-interactive Docker runs. `uv` is preferred; `pipx` is the minimum fallback for isolated CLI installs.
- **Global packages**: do not preinstall project-level tools such as pytest, ruff, mypy, poetry, flask, django, or fastapi. Target repos own those dependencies.
- **Native build baseline**: common compiler/build basics may be added if the image-size increase is acceptable. Domain-specific headers and heavyweight stacks stay out of scope.
- **Version selection**: no `.python-version`, `.tool-versions`, `.mise.toml`, `pyproject.toml`, or runtime-detection behavior in this plan. A single baked system Python is the feature.
- **Release component**: Dockerfile/image-input changes belong to the synthetic `ralph-sandbox` component. npm packages should not bump for this image-only feature.
- **Verification seam**: the highest useful test seam is a Docker image smoke test that validates the container's external Python contract.
- **Docs contract**: user-facing docs must name Python as part of the sandbox image and clearly state that pinned Python version selection is future work.

---

## Phase 1: Baseline Python Runtime

**User stories**: 1, 2, 3, 6, 8, 9, 10, 11, 14, 16, 19, 20, 22

### What to build

Make Python a real image contract instead of an accidental base-image detail. The sandbox image should build cleanly, run as the existing `agent` user, expose Python through both command names, and create a working project-local virtual environment with pip available inside it.

This phase proves the smallest useful Python path end-to-end: a Python repo can be mounted into the sandbox, the agent can create a virtual environment, and dependency installation has a proper place to happen.

### Acceptance criteria

- [ ] The sandbox image builds locally from the repo root using the existing Dockerfile path and image-build command shape.
- [ ] `docker run --rm <image> python --version` exits successfully and reports Python 3.
- [ ] `docker run --rm <image> python3 --version` exits successfully and reports Python 3.
- [ ] `docker run --rm <image> python -m venv /tmp/ralph-python-smoke` exits successfully as the `agent` user.
- [ ] The virtual environment's Python can run `-m pip --version`.
- [ ] The implementation respects Debian's externally-managed system Python model; project dependency installs are validated inside a virtual environment, not against system Python.
- [ ] No project-level Python tools are installed globally as part of the baseline runtime.
- [ ] No core loop, runner, CLI, stage, or prompt behavior changes are introduced.
- [ ] Existing release-please path-scoping tests still confirm that an image-input change bumps `ralph-sandbox`, not `ralph-core` or `ralph`.

---

## Phase 2: Modern Python Tooling

**User stories**: 4, 5, 12, 13, 14, 15, 16, 24

### What to build

Add the minimal modern Python tooling needed for common Python repos without turning the image into an opinionated Python application stack. Prefer `uv` if it can be installed in a way that is stable for the `agent` user and available in non-interactive `docker run` commands. Keep `pipx` as the isolated-CLI fallback or complement.

This phase proves that the sandbox can handle both classic and current Python workflows: creating an environment, installing a tiny dependency, and invoking the chosen package tool from the same user context the agent uses.

### Acceptance criteria

- [ ] The chosen modern package tool reports a version from a plain non-interactive container run.
- [ ] The chosen tool is available on `PATH` for the `agent` user without relying on interactive shell startup files.
- [ ] A virtual environment can install a small pure-Python dependency from PyPI when network access is available.
- [ ] If `uv` is included, `uv --version` works and at least one `uv`-based environment or install smoke succeeds.
- [ ] If `pipx` is included, `pipx --version` works and its install location is writable by the `agent` user.
- [ ] The implementation does not globally install test, lint, framework, data science, ML, browser automation, or database-specific Python packages.
- [ ] Any native-build prerequisites added to the image are limited to a generic build baseline and their image-size impact is recorded for review.
- [ ] Existing Node, .NET, `gh`, `jq`, git, Claude Code, workdir, user, and entrypoint behavior continue to work after the Python additions.

---

## Phase 3: Image Smoke Guard

**User stories**: 7, 18, 21

### What to build

Create a repeatable image smoke check that maintainers can run before publishing a sandbox image. The smoke should exercise the image contract from outside the container, fail with clear messages, and avoid coupling to apt package names or Dockerfile layer ordering.

This phase turns Python support from a one-time manual verification into a durable guardrail for future image changes.

### Acceptance criteria

- [ ] A root-level smoke command can build or accept a prebuilt sandbox image tag and run the Python contract checks against it.
- [ ] The smoke verifies `python`, `python3`, `venv`, pip inside the virtual environment, and the chosen modern package tool.
- [ ] Network-dependent package-install verification is either clearly marked as requiring network or can be skipped with an explicit flag/env var.
- [ ] Smoke failures identify the missing or broken contract in plain language.
- [ ] The smoke command is documented in the maintainer verification flow for image changes.
- [ ] Ordinary non-image CI remains reasonably fast; if the full Docker build smoke is not added to every PR, the release checklist treats it as required before publishing.
- [ ] Existing root tests and smoke checks still pass after adding the new image smoke path.

---

## Phase 4: Docs And Release Readiness

**User stories**: 17, 21, 23, 24, 25

### What to build

Update the public and maintainer-facing docs so the image contract matches reality. The docs should make Python discoverable to users, explain the project-local environment expectation, and set clear boundaries around what this first Python release does not do.

This phase also performs the final release-readiness pass: local verification, image smoke, and one toy Python repo run if credentials are available.

### Acceptance criteria

- [ ] The main image bundle description names Python, venv support, and the chosen modern Python package tool.
- [ ] Quickstart/setup docs do not require extra Python installation for basic Python repos.
- [ ] Architecture docs describe Python as part of the sandbox image contents.
- [ ] Docs clearly state that pinned Python version detection is not included in this release.
- [ ] Docs steer agents/users toward virtual environments or isolated tooling, not global system-Python installs.
- [ ] The release notes or maintainer checklist identify this as a `ralph-sandbox` image release, not an npm package release.
- [ ] Full repo verification passes for non-image code paths.
- [ ] The Python image smoke passes against the final local image tag.
- [ ] A toy Python repo can complete a basic container-level workflow: create venv, install dependency, run a Python command or test.
- [ ] If Claude credentials are available, one Ralph iteration against a tiny Python repo succeeds without a custom image.
