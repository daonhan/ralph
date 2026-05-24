# Changelog

## [0.6.0](https://github.com/daonhan/ralph/compare/ralph-core-v0.5.1...ralph-core-v0.6.0) (2026-05-24)

### Features

* **core:** keep AFK runs awake by default with per-OS sleep inhibitors
* **core:** add per-stage retry/backoff, detach mode, completion/failure notifications, and AFK flag wiring

### Bug Fixes

* **core:** abort active Docker work during image setup and stage execution on SIGINT/SIGTERM
* **core:** log terminal stage failures, warn on early wake-lock exit, and escape macOS notification backslashes

## [0.5.1](https://github.com/daonhan/ralph/compare/ralph-core-v0.5.0...ralph-core-v0.5.1) (2026-05-22)


### Features

* **core:** --version flag + docker socket config in --print-config ([45abd79](https://github.com/daonhan/ralph/commit/45abd79ec6a1571d7f2d8556d53396f3c2b61c9c))
* **core:** add --version flag and surface docker socket config in --print-config ([9181c77](https://github.com/daonhan/ralph/commit/9181c7728b301d875083999ff81c35d70d6d23ef))

## [0.5.0](https://github.com/daonhan/ralph/compare/ralph-core-v0.4.2...ralph-core-v0.5.0) (2026-05-22)


### Features

* add ralph-sandbox synthetic image component ([ba29f18](https://github.com/daonhan/ralph/commit/ba29f18623fd75e873e7fd3e8f917c232f0ef230))
* **core:** bind-mount host Docker socket into sandbox ([639c3cf](https://github.com/daonhan/ralph/commit/639c3cf0d758ec8d78ea9b0eea5d8e79cc3e4b4e))
* **core:** bind-mount host Docker socket into sandbox ([ac27644](https://github.com/daonhan/ralph/commit/ac27644dd2472795bd5691eaa7c08e80ee6042e3))
* global CLI install + container git fix ([fe6e181](https://github.com/daonhan/ralph/commit/fe6e181c47cc4f2caef9934ab7c50f8d7a906fb0))
* pretty CLI output with Claude-Code-style rendering ([a8c8b97](https://github.com/daonhan/ralph/commit/a8c8b97a5564299a71f806eca260e1bc7f936643))


### Bug Fixes

* address PR [#5](https://github.com/daonhan/ralph/issues/5) review feedback ([fae8111](https://github.com/daonhan/ralph/commit/fae8111d4bb57358458410808aee6d5c21c1a231))
* **core:** address PR [#7](https://github.com/daonhan/ralph/issues/7) review feedback ([0ced1f7](https://github.com/daonhan/ralph/commit/0ced1f77ea695d60f338c8675ddb37c2be74c28d))
* **core:** grant root group on Docker Desktop so agent can use docker.sock ([d29a9b5](https://github.com/daonhan/ralph/commit/d29a9b5a2bd8cbb88c82d04ad4dfddc86ecb6ebb))
* **core:** publish 0.4.1 with dist; clean stale tsbuildinfo ([c3706bd](https://github.com/daonhan/ralph/commit/c3706bd9415bd9e8b6dc6b77bcc66361e244ff41))
* **core:** pull fresh image when ref is floating ([be68c2e](https://github.com/daonhan/ralph/commit/be68c2ecd1b8b1d96c85d8bc21caf3c0022f68df))
* **core:** spill heavy template output to side files ([0571a67](https://github.com/daonhan/ralph/commit/0571a67728a7ae4353a24ba1bfa0a2d2433952dd))
* trust workspace bind mount in container git ([4de683d](https://github.com/daonhan/ralph/commit/4de683d28453e002ce87ed9b94c5d9273945ad5e))


### Code Refactoring

* restructure CLI scripts and templates ([6de08b2](https://github.com/daonhan/ralph/commit/6de08b2fd59ad0aeefefd636052addebda3d6a64))
* update templates to use try-shell syntax for improved error handling ([a50e504](https://github.com/daonhan/ralph/commit/a50e504dc013bc88709ec2563b5a6d9f25da1764))


### Miscellaneous Chores

* **main:** release ralph-core 0.2.0 ([22f7a32](https://github.com/daonhan/ralph/commit/22f7a32cc89f49af5d602051341d4c7c53d680e0))
* **main:** release ralph-core 0.2.0 ([06bdf70](https://github.com/daonhan/ralph/commit/06bdf704e81a7732f476a226915f5d083b2cd462))
* **main:** release ralph-core 0.3.0 ([f94fcc1](https://github.com/daonhan/ralph/commit/f94fcc1d3c30856511c2c96e71f18706265cab73))
* **main:** release ralph-core 0.3.0 ([0d852b5](https://github.com/daonhan/ralph/commit/0d852b53653758c6d1cc01162f71264c6a3a1fba))
* **main:** release ralph-core 0.3.1 ([5c77561](https://github.com/daonhan/ralph/commit/5c77561afb40798d073c4b0f22b6eb505ac96188))
* **main:** release ralph-core 0.3.1 ([47c7fd6](https://github.com/daonhan/ralph/commit/47c7fd6be9f9d1fc8bd0af8b570c12c7660f10bf))
* release ralph-core@0.4.0 and ralph@0.4.0 ([d29e239](https://github.com/daonhan/ralph/commit/d29e23916b6b3656be40a85f32df61d59e17fdeb))

## [0.3.1](https://github.com/daonhan/ralph/compare/ralph-core-v0.3.0...ralph-core-v0.3.1) (2026-05-21)


### Bug Fixes

* **core:** address PR [#7](https://github.com/daonhan/ralph/issues/7) review feedback ([0ced1f7](https://github.com/daonhan/ralph/commit/0ced1f77ea695d60f338c8675ddb37c2be74c28d))
* **core:** publish 0.4.1 with dist; clean stale tsbuildinfo ([c3706bd](https://github.com/daonhan/ralph/commit/c3706bd9415bd9e8b6dc6b77bcc66361e244ff41))
* **core:** spill heavy template output to side files ([0571a67](https://github.com/daonhan/ralph/commit/0571a67728a7ae4353a24ba1bfa0a2d2433952dd))


### Miscellaneous Chores

* release ralph-core@0.4.0 and ralph@0.4.0 ([d29e239](https://github.com/daonhan/ralph/commit/d29e23916b6b3656be40a85f32df61d59e17fdeb))

## [0.3.0](https://github.com/daonhan/ralph/compare/ralph-core-v0.2.0...ralph-core-v0.3.0) (2026-05-21)


### Features

* pretty CLI output with Claude-Code-style rendering ([a8c8b97](https://github.com/daonhan/ralph/commit/a8c8b97a5564299a71f806eca260e1bc7f936643))


### Bug Fixes

* address PR [#5](https://github.com/daonhan/ralph/issues/5) review feedback ([fae8111](https://github.com/daonhan/ralph/commit/fae8111d4bb57358458410808aee6d5c21c1a231))

## [0.2.0](https://github.com/daonhan/ralph/compare/ralph-core-v0.1.1...ralph-core-v0.2.0) (2026-05-21)


### Features

* add ralph-sandbox synthetic image component ([ba29f18](https://github.com/daonhan/ralph/commit/ba29f18623fd75e873e7fd3e8f917c232f0ef230))
* global CLI install + container git fix ([fe6e181](https://github.com/daonhan/ralph/commit/fe6e181c47cc4f2caef9934ab7c50f8d7a906fb0))


### Bug Fixes

* **core:** pull fresh image when ref is floating ([be68c2e](https://github.com/daonhan/ralph/commit/be68c2ecd1b8b1d96c85d8bc21caf3c0022f68df))
* trust workspace bind mount in container git ([4de683d](https://github.com/daonhan/ralph/commit/4de683d28453e002ce87ed9b94c5d9273945ad5e))


### Code Refactoring

* restructure CLI scripts and templates ([6de08b2](https://github.com/daonhan/ralph/commit/6de08b2fd59ad0aeefefd636052addebda3d6a64))
* update templates to use try-shell syntax for improved error handling ([a50e504](https://github.com/daonhan/ralph/commit/a50e504dc013bc88709ec2563b5a6d9f25da1764))
