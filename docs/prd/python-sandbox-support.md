# PRD: Python Support for ralph-sandbox

## Problem Statement

As a Ralph user, when I point `ralph-afk` or `ralph-ghafk` at a Python repository, the sandbox image does not make Python an explicit supported runtime. The image is currently documented around Node 22, .NET SDK 10, GitHub CLI, common shell utilities, and Claude Code. If Python is present only by accident through the base image or a transitive package, users cannot rely on it for agent work.

That means a Python repo can fail at the first basic task: creating a virtual environment, installing dependencies from `pyproject.toml` or `requirements.txt`, running tests, or invoking standard Python tooling. Worse, a task might pass locally only because the current image happens to contain a Python binary, then break later when the base image changes and that implicit dependency disappears.

Python support is now a concrete need. The earlier multi-version runtime work intentionally left Python out until a concrete need appeared; this PRD scopes the first Python step as a small, reliable image contract rather than a full runtime-detection system.

## Solution

The sandbox image will explicitly support Python as a first-class baked runtime. From the user's perspective, a Python repo should work in the same ordinary way a Node or .NET repo works today:

- `python` and `python3` are available in every container.
- `python -m venv` works, so agents can create project-local virtual environments.
- `python -m pip` is available inside virtual environments.
- A modern Python package runner/installer is available for repos that use current Python workflows.
- Ralph documentation names Python as part of the image contract.
- Release and smoke verification catch a future image change that accidentally drops Python support.

This PRD intentionally starts with one system Python from the Debian Bookworm package stream. It does not try to pick Python versions from project manifests yet. The first win is simple: Python repos are no longer relying on an accidental base-image detail.

## User Stories

1. As a Ralph user with a Python repository, I want `python` to exist inside the sandbox, so that the agent can run normal Python commands without first installing a runtime.
2. As a Ralph user with a Python repository, I want `python3` to exist inside the sandbox, so that scripts and documentation that use the explicit Python 3 command keep working.
3. As a Ralph user with a Python package, I want `python -m venv` to work, so that the agent can isolate dependencies in a project-local virtual environment.
4. As a Ralph user with a `requirements.txt` file, I want the agent to be able to install dependencies into a virtual environment, so that it can run my tests.
5. As a Ralph user with a `pyproject.toml` file, I want the sandbox to support modern Python project workflows, so that agents can install and test the project without special bootstrapping.
6. As a Ralph user with a repo that documents `python` instead of `python3`, I want the `python` command to map to Python 3, so that existing scripts do not fail on command-name differences.
7. As a Ralph user, I want Python support to be part of the published image contract, so that I can trust it across image rebuilds.
8. As a Ralph user, I want Python support to work without a private image fork, so that I can use the default `daonhan/ralph-sandbox` image.
9. As a Ralph user, I want Python support to work in the same bind-mounted workspace model as the rest of Ralph, so that dependencies and generated files land in my repo when the agent creates them.
10. As a Ralph user, I want agents to prefer project-local environments over global Python installs, so that one repo's dependencies do not pollute another repo's run.
11. As a Ralph user, I want the sandbox to include enough Python packaging basics for common repos, so that trivial Python tasks do not spend their first iteration installing infrastructure.
12. As a Ralph user using `uv`, I want the sandbox to include `uv` or a documented equivalent, so that current fast Python workflows are available out of the box.
13. As a Ralph user using `pipx`-style isolated CLI installs, I want `pipx` or an equivalent isolated tool path available, so that the agent can install one-off Python CLIs without polluting system packages.
14. As a Ralph user on Debian-based tooling, I want the image to respect externally-managed-system-Python behavior, so that package installs go into virtual environments or tool-managed locations rather than breaking system Python.
15. As a Ralph user with native Python dependencies, I want the implementation to consider build prerequisites, so that packages with C extensions can compile when prebuilt wheels are unavailable.
16. As a Ralph user on a slow connection, I want the Python addition to avoid unnecessary heavyweight global packages, so that the sandbox image does not grow more than needed.
17. As a Ralph user, I want the image docs to tell me what Python support means, so that I know whether I need a custom image for a pinned Python version.
18. As a Ralph maintainer, I want a cheap smoke test for Python image support, so that a future Dockerfile edit cannot accidentally remove it.
19. As a Ralph maintainer, I want Python support isolated to the sandbox image component, so that adding Python does not force an npm package release.
20. As a Ralph maintainer, I want release-please to route the change to the synthetic image component, so that the Docker image version is the only artifact that bumps.
21. As a Ralph maintainer, I want CI or a manual release checklist to verify `python`, `venv`, and package installation behavior, so that the published image is trustworthy before `:latest` moves.
22. As a Ralph maintainer, I want the first Python release to stay smaller than the earlier multi-version-runtime plan, so that the project gets immediate value without taking on runtime detection and cache-volume complexity.
23. As a Ralph maintainer, I want Python version detection called out as future work, so that this PRD does not accidentally promise `.python-version` or `.tool-versions` behavior.
24. As a Ralph maintainer, I want framework-specific Python tooling left to target repos, so that the image does not preinstall every possible test, lint, or web framework.
25. As a Ralph maintainer, I want the docs to match the image contents, so that README, Quickstart, and architecture references do not drift.

## Implementation Decisions

### Scope

- Treat this as a `ralph-sandbox` image feature, not a core loop feature. No changes are needed to stage orchestration, template rendering, Docker-run argument construction, or CLI parsing.
- Keep the first version intentionally static: one baked Python runtime from the Debian Bookworm package stream. Version selection and manifest detection are future work.
- Preserve the existing base-image strategy and add Python packages to the existing system-dependency installation flow.
- Keep the existing non-root `agent` runtime user model. Python tooling must work for that user in the bind-mounted workspace.

### Baked Python Contract

- The image provides both `python3` and `python`, with `python` resolving to Python 3.
- The image provides `venv` support so project-local virtual environments can be created without additional apt packages.
- The image provides pip behavior suitable for virtual environments. Agents should install project dependencies into a virtual environment or an isolated tool-managed location rather than into system Python.
- The image includes a modern fast Python package tool. `uv` is the preferred default if its install path is reliable under the `agent` user; otherwise `pipx` is the fallback minimum for isolated CLI installation.
- Avoid preinstalling project-level tools like pytest, ruff, mypy, poetry, flask, django, or fastapi. Those belong to the target repo's dependency declaration.

### Native Build Support

- Include common build prerequisites only if they are needed for a useful baseline. The default recommendation is to include compiler/build basics if the image size increase is acceptable, because many Python packages still compile native extensions on less-common platforms or versions.
- Do not add database-client development headers, browser automation dependencies, ML stacks, or scientific libraries in this PRD. Those are too domain-specific for the base sandbox image.

### Documentation Contract

- The user-facing image bundle list should name Python explicitly.
- The architecture docs should describe Python as part of the sandbox image contents.
- The quickstart path should not require extra Python setup for basic Python repos.
- Documentation should state that only the baked system Python is supported in this PRD, and that project-specific Python version selection requires a custom image or future runtime detection work.

### Release Contract

- The change belongs to the synthetic Docker image component because it changes image inputs under the templates-owned area.
- Release-please should produce a `ralph-sandbox` release only. The npm packages should not be bumped for this minimal image-only change.
- The published image should continue to use the existing image workflow and tagging scheme.

## Testing Decisions

Good tests for this feature verify the image's external contract: commands that a Python repo expects should work inside a container built from the sandbox Dockerfile. Tests should not assert apt package internals or installation-layer ordering.

The highest useful seam is a Docker image smoke test. It should build the sandbox image from the Dockerfile, run a disposable container, and verify:

- `python --version` exits successfully and reports Python 3.
- `python3 --version` exits successfully.
- `python -m venv /tmp/venv` creates a virtual environment.
- The virtual environment's Python can run `-m pip --version`.
- A tiny dependency can be installed into the virtual environment from PyPI, if network-enabled smoke tests are acceptable.
- The chosen modern package tool reports a version.

For fast local and CI feedback, the smoke can be implemented as a small root-level script following the existing smoke-script style: command-line oriented, clear failure messages, no coupling to implementation details. The script can be optional in ordinary CI if Docker build time is too expensive, but it should be part of the release checklist before publishing the image.

Prior art in the repo:

- Existing root smoke scripts validate rendered templates and spill behavior from the outside.
- The image integration script already exercises the real Docker CLI for image-resolution behavior.
- The release-please config test already protects the synthetic image component's path routing.

Manual verification before release:

1. Build the sandbox image locally.
2. Run `python --version` and `python3 --version` in the image.
3. Create a virtual environment under `/tmp`.
4. Install one trivial package inside that virtual environment.
5. Verify the modern package tool is callable as the `agent` user.
6. Run a toy Python repo through one Ralph iteration if Claude credentials are available.

## Out of Scope

- Python version detection from `.python-version`, `.tool-versions`, `.mise.toml`, `runtime.txt`, `pyproject.toml`, or similar manifests.
- Lazy installation of alternate Python versions.
- Docker named-volume caching for Python runtimes.
- Reworking the broader multi-version runtime plan.
- Installing project-specific Python tooling globally.
- Installing heavy Python stacks such as data science, ML, browser automation, or database-client packages.
- Supporting Python 2.
- Guaranteeing exact patch-level Python versions across all future Debian Bookworm package updates.
- Changing the Ralph prompt templates to give Python-specific instructions.
- Changing stage orchestration or Docker-run environment plumbing.
- Publishing a separate Python-specific image variant.

## Further Notes

- Debian Bookworm's system Python is externally managed, so global `pip install` against system Python is the wrong contract. The image should make virtual environments and isolated tool installs easy instead.
- `uv` gives the best user experience for modern Python repos, but the implementer should verify its install method is stable for a non-root `agent` user and does not depend on shell startup files that Docker's `CMD` path skips.
- `pipx` is useful as a fallback or complement for isolated Python CLI installs, but it should not replace project-local virtual environments for repo dependencies.
- If image size becomes a concern, build prerequisites can be revisited. The minimum viable support is the Python runtime, `venv`, packaging basics, and documentation.
- This PRD is deliberately narrower than the existing multi-version runtime PRD. A future Python runtime-detection PRD can extend the existing detection vocabulary with `.python-version`, `.tool-versions`, and `.mise.toml` once users need pinned versions.
