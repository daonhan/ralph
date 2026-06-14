# Changelog

## [0.7.0](https://github.com/phamvuhoang/ralph/compare/ralph-core-v0.6.3...ralph-core-v0.7.0) (2026-06-14)


### revert

* undo phantom ralph-core 0.5.1 release ([#4](https://github.com/phamvuhoang/ralph/issues/4)); steer next to 0.7.0 ([36daf4b](https://github.com/phamvuhoang/ralph/commit/36daf4b547033b97e32ea2794fc4b4ae8a492f32))


### Features

* add ralph-sandbox synthetic image component ([ba29f18](https://github.com/phamvuhoang/ralph/commit/ba29f18623fd75e873e7fd3e8f917c232f0ef230))
* **cli:** --budget and --cooldown flags + print-config ([8dcff31](https://github.com/phamvuhoang/ralph/commit/8dcff31e1cc18802d2042b2ad7c81742596d535a))
* **cli:** --watch / --watch-interval; ghafk-only dispatch to runWatch ([05401c4](https://github.com/phamvuhoang/ralph/commit/05401c40b7b208bef8689635a37ec3ce16eccfcc))
* **core:** --detach fork-and-exit (Phase 3 of [#20](https://github.com/phamvuhoang/ralph/issues/20)) ([2e815d7](https://github.com/phamvuhoang/ralph/commit/2e815d761a9d8d01cef70c04e60a9206c7306aad))
* **core:** --notify OS toast + bell (Phase 4 of [#21](https://github.com/phamvuhoang/ralph/issues/21)) ([5755efb](https://github.com/phamvuhoang/ralph/commit/5755efb9c21c82426b3d9b70256b7bc869858128))
* **core:** --version flag + docker socket config in --print-config ([45abd79](https://github.com/phamvuhoang/ralph/commit/45abd79ec6a1571d7f2d8556d53396f3c2b61c9c))
* **core:** add --version flag and surface docker socket config in --print-config ([9181c77](https://github.com/phamvuhoang/ralph/commit/9181c7728b301d875083999ff81c35d70d6d23ef))
* **core:** add keep-alive wake-lock + signal handling (Phase 1 of [#18](https://github.com/phamvuhoang/ralph/issues/18)) ([93e8efe](https://github.com/phamvuhoang/ralph/commit/93e8efeaa000fca5bb3574d3114b6ec479822465))
* **core:** bind-mount host Docker socket into sandbox ([639c3cf](https://github.com/phamvuhoang/ralph/commit/639c3cf0d758ec8d78ea9b0eea5d8e79cc3e4b4e))
* **core:** bind-mount host Docker socket into sandbox ([ac27644](https://github.com/phamvuhoang/ralph/commit/ac27644dd2472795bd5691eaa7c08e80ee6042e3))
* **core:** per-stage retry default-on (Phase 2 of [#19](https://github.com/phamvuhoang/ralph/issues/19)) ([5163c15](https://github.com/phamvuhoang/ralph/commit/5163c15ea13985d263ee755ba617ad391a6947e3))
* **core:** print cli + core version banner at loop init ([2cc0fbc](https://github.com/phamvuhoang/ralph/commit/2cc0fbcde7858ad01be0e0fbc0256b351f9ef51e))
* **core:** wire RALPH_MODEL through to sandbox claude --model ([a76da10](https://github.com/phamvuhoang/ralph/commit/a76da10c4615e4ae3b84d94873d2125fb4e54aa8))
* global CLI install + container git fix ([fe6e181](https://github.com/phamvuhoang/ralph/commit/fe6e181c47cc4f2caef9934ab7c50f8d7a906fb0))
* **learnings:** inject .ralph/LEARNINGS.md into stage prompts ([5d4b11d](https://github.com/phamvuhoang/ralph/commit/5d4b11d37d7c20ef80eb235f3c17da00e0fe6fec))
* **learnings:** instruct implementers to record durable learnings ([9c1aa91](https://github.com/phamvuhoang/ralph/commit/9c1aa910c3f8c4569c76c972b2155c27a5bf4d8c))
* **learnings:** let reviewer/synth record learnings; keep lenses read-only ([4666b3b](https://github.com/phamvuhoang/ralph/commit/4666b3bcbf8dc868393828fd89b3857f2648ead2))
* **loop:** injected signal + LoopOutcome return for daemon callers ([8b9c905](https://github.com/phamvuhoang/ralph/commit/8b9c905e518bedb8b48602f24ab60a9646ef133f))
* **loop:** track stage cost, enforce --budget, pace with --cooldown + adaptive backoff ([e5a42d2](https://github.com/phamvuhoang/ralph/commit/e5a42d253ffbb477901acda99ea85d30ca46a1ba))
* **loop:** use bin name in wake-lock reason for runLoop ([8299ad8](https://github.com/phamvuhoang/ralph/commit/8299ad81a2c2f51f5833a3e278c32c15ea872261))
* **pacing:** abortable sleep + adaptive cooldown helpers ([df51a5a](https://github.com/phamvuhoang/ralph/commit/df51a5ad3615e09a73061fc237f988168a5db14d))
* **panel:** harness-orchestrated reviewer panel (lenses → synth) ([8454830](https://github.com/phamvuhoang/ralph/commit/8454830c66a1defe89c09a4c737c18c8fde8e301))
* pretty CLI output with Claude-Code-style rendering ([a8c8b97](https://github.com/phamvuhoang/ralph/commit/a8c8b97a5564299a71f806eca260e1bc7f936643))
* **render:** generic {{ KEY }} substitution (was INPUTS-only) ([ae7bfa3](https://github.com/phamvuhoang/ralph/commit/ae7bfa3786c8c1f5bac480cf8112fd97c42d1fef))
* **runner:** add runner-selection + sandbox-settings helpers ([19f3baf](https://github.com/phamvuhoang/ralph/commit/19f3baf4e2625a35ced7c8d9edfc285a04eb0319))
* **runner:** inject --settings into the claude argv ([bb3f106](https://github.com/phamvuhoang/ralph/commit/bb3f1061894f752cded3f9d4284c03b38cc9408d))
* **templates:** review-lens + review-synth panel prompts ([ccc5e14](https://github.com/phamvuhoang/ralph/commit/ccc5e148bea41aed89b738be05ec952b77ce858a))
* **watch:** runWatch daemon — poll labelled issues, cumulative budget ([f680483](https://github.com/phamvuhoang/ralph/commit/f6804830b15be1a89a73188bb25dc838606a7388))
* wire --review-panel / RALPH_REVIEW_LENSES into the loop ([e4e2300](https://github.com/phamvuhoang/ralph/commit/e4e23008b6a74b975ad1c08b2e6f7aa5c470cd29))


### Bug Fixes

* address PR [#5](https://github.com/phamvuhoang/ralph/issues/5) review feedback ([fae8111](https://github.com/phamvuhoang/ralph/commit/fae8111d4bb57358458410808aee6d5c21c1a231))
* **core:** abort image setup on signals ([6cd15e8](https://github.com/phamvuhoang/ralph/commit/6cd15e8c6b9a2e5e8df5afa8a7e5ba59a46d177f))
* **core:** address PR [#7](https://github.com/phamvuhoang/ralph/issues/7) review feedback ([0ced1f7](https://github.com/phamvuhoang/ralph/commit/0ced1f77ea695d60f338c8675ddb37c2be74c28d))
* **core:** document docker-kill recovery for ralph-core &lt;= 0.6.0 post-result hang ([3e8cf76](https://github.com/phamvuhoang/ralph/commit/3e8cf760268c96a03ae5646eacca8d30f1e69cdb))
* **core:** grace-timer streamDocker recovers from post-result claude hang ([994ba05](https://github.com/phamvuhoang/ralph/commit/994ba05fb02910bb573becb0047e0b6d1ece0280))
* **core:** grant root group on Docker Desktop so agent can use docker.sock ([d29a9b5](https://github.com/phamvuhoang/ralph/commit/d29a9b5a2bd8cbb88c82d04ad4dfddc86ecb6ebb))
* **core:** handle AFK signal cleanup ([f251129](https://github.com/phamvuhoang/ralph/commit/f2511291f42c6d0220493e33119fc167d6437cfd))
* **core:** post-result grace timer in streamDocker (closes [#30](https://github.com/phamvuhoang/ralph/issues/30)) ([31a4312](https://github.com/phamvuhoang/ralph/commit/31a43125540c1ca085d4727a6840f9d47a05cee4))
* **core:** publish 0.4.1 with dist; clean stale tsbuildinfo ([c3706bd](https://github.com/phamvuhoang/ralph/commit/c3706bd9415bd9e8b6dc6b77bcc66361e244ff41))
* **core:** pull fresh image when ref is floating ([be68c2e](https://github.com/phamvuhoang/ralph/commit/be68c2ecd1b8b1d96c85d8bc21caf3c0022f68df))
* **core:** spill heavy template output to side files ([0571a67](https://github.com/phamvuhoang/ralph/commit/0571a67728a7ae4353a24ba1bfa0a2d2433952dd))
* **core:** warn on docker.sock mount; refactor bin/runner internals ([d5cd486](https://github.com/phamvuhoang/ralph/commit/d5cd48696a850776e8b954e61b0e40dd9a1dec89))
* **ghafk:** fail loud on gh issue-fetch errors instead of false-completing ([74832b8](https://github.com/phamvuhoang/ralph/commit/74832b80d44b3357c4d197e6d282048336d8cfa4))
* **ghafk:** remove silent fallbacks for issue list commands ([bd2b94d](https://github.com/phamvuhoang/ralph/commit/bd2b94d1aa39f3d316fbd02ef3826f4c7e5c7f09))
* **ghafk:** surface issue fetch failures ([0e5d3a2](https://github.com/phamvuhoang/ralph/commit/0e5d3a2b4910db22f1eef4907c9b105857a96340))
* **panel:** enforce lens read-only; route sub-agents through budget/pacing ([db622d5](https://github.com/phamvuhoang/ralph/commit/db622d54ab67108d913a6999b37aa225f23a1103))
* **panel:** only enforce lens read-only when worktree starts clean ([b8b368d](https://github.com/phamvuhoang/ralph/commit/b8b368d1520d7b1a2ee0c79f8c1e01df546d74ca))
* **release:** recover from phantom 0.5.1; steer ralph-core to 0.7.0 ([704a2a9](https://github.com/phamvuhoang/ralph/commit/704a2a9f5c6ec51fedc0084587ca9f1908ea35af))
* **release:** revert premature 0.6.3 bump so release-please anchors on 0.6.2 ([d290a65](https://github.com/phamvuhoang/ralph/commit/d290a65b60abe427c6a38b266a0cc2b1eac1ac5c))
* **release:** revert premature 0.6.3 bump so release-please anchors on 0.6.2 ([add45ea](https://github.com/phamvuhoang/ralph/commit/add45eab9068fce3168f9b16ede195f8a7c36ed1))
* remove package-lock.json, improve JSDoc, rename stageWithPerm ([18f9150](https://github.com/phamvuhoang/ralph/commit/18f915079744b992844d493e7a1edb0dfb635f91))
* retarget the plan/PRD playbook and dedup the shared playbook body ([d950995](https://github.com/phamvuhoang/ralph/commit/d9509958fd4f7fd24c71c722953b99a493321737))
* **retry:** never retry an AbortError ([404e5b2](https://github.com/phamvuhoang/ralph/commit/404e5b22066d742b9174e9faf21802e70baa6891))
* **review:** remove unused escSingleQuote in notify ([beb4f06](https://github.com/phamvuhoang/ralph/commit/beb4f0639310c04a15a50b7f7fae6c28c7d07a02))
* **review:** validate args before detach fork; add detach tests ([676e9ef](https://github.com/phamvuhoang/ralph/commit/676e9ef60775d5b2acf7d969d965afc75a5425a9))
* trust workspace bind mount in container git ([4de683d](https://github.com/phamvuhoang/ralph/commit/4de683d28453e002ce87ed9b94c5d9273945ad5e))
* **watch:** pass label as argv (no shell); honor --max-retries / --review-panel ([8c35d3f](https://github.com/phamvuhoang/ralph/commit/8c35d3f2665586c8c8de33b46c1f3a211c58afea))


### Code Refactoring

* extract executeStage (render+retry+runStage) for reuse ([fa7b4bd](https://github.com/phamvuhoang/ralph/commit/fa7b4bdc080e4faa90fde4a633642d2ab1aaf89c))
* restructure CLI scripts and templates ([6de08b2](https://github.com/phamvuhoang/ralph/commit/6de08b2fd59ad0aeefefd636052addebda3d6a64))
* **runner:** spawn claude on the host, delete all docker plumbing ([e215741](https://github.com/phamvuhoang/ralph/commit/e215741eddb14223bf2fa1340510358311f600f5))
* update templates to use try-shell syntax for improved error handling ([a50e504](https://github.com/phamvuhoang/ralph/commit/a50e504dc013bc88709ec2563b5a6d9f25da1764))


### Miscellaneous Chores

* **main:** release ralph-core 0.2.0 ([22f7a32](https://github.com/phamvuhoang/ralph/commit/22f7a32cc89f49af5d602051341d4c7c53d680e0))
* **main:** release ralph-core 0.2.0 ([06bdf70](https://github.com/phamvuhoang/ralph/commit/06bdf704e81a7732f476a226915f5d083b2cd462))
* **main:** release ralph-core 0.3.0 ([f94fcc1](https://github.com/phamvuhoang/ralph/commit/f94fcc1d3c30856511c2c96e71f18706265cab73))
* **main:** release ralph-core 0.3.0 ([0d852b5](https://github.com/phamvuhoang/ralph/commit/0d852b53653758c6d1cc01162f71264c6a3a1fba))
* **main:** release ralph-core 0.3.1 ([5c77561](https://github.com/phamvuhoang/ralph/commit/5c77561afb40798d073c4b0f22b6eb505ac96188))
* **main:** release ralph-core 0.3.1 ([47c7fd6](https://github.com/phamvuhoang/ralph/commit/47c7fd6be9f9d1fc8bd0af8b570c12c7660f10bf))
* **main:** release ralph-core 0.5.0 ([3a50ab6](https://github.com/phamvuhoang/ralph/commit/3a50ab609f748a6bf71b9320f0d300dd59a7793f))
* **main:** release ralph-core 0.5.0 ([a59d227](https://github.com/phamvuhoang/ralph/commit/a59d22722b82b4dd37c0a31735484eb7201af3b7))
* **main:** release ralph-core 0.5.1 ([c4e080c](https://github.com/phamvuhoang/ralph/commit/c4e080c68bb4cc62431217dbc1725cd75264ab71))
* **main:** release ralph-core 0.5.1 ([5180b84](https://github.com/phamvuhoang/ralph/commit/5180b84a7c8c4d563405f77c67a3796a9a141989))
* **main:** release ralph-core 0.5.1 ([b160bf9](https://github.com/phamvuhoang/ralph/commit/b160bf9814530b3c4299a36cca779feae663af98))
* **main:** release ralph-core 0.5.1 ([01c8066](https://github.com/phamvuhoang/ralph/commit/01c806686d644b052a7a30fb83ea39c33b1a63a4))
* **main:** release ralph-core 0.5.1 ([56876d2](https://github.com/phamvuhoang/ralph/commit/56876d2c1dc0c7d9b075e0163774a9ae2617291f))
* **main:** release ralph-core 0.5.1 ([7089aea](https://github.com/phamvuhoang/ralph/commit/7089aeac702da778a5f13383d5c1ff65213c3737))
* **main:** release ralph-core 0.6.3 ([0f4f569](https://github.com/phamvuhoang/ralph/commit/0f4f56951d75a8edee5d5e95c607298bbf14b995))
* **main:** release ralph-core 0.6.3 ([bcbe38a](https://github.com/phamvuhoang/ralph/commit/bcbe38aafc5aeb49d9dbd27d66ce94a5649d8eb9))
* **main:** release ralph-sandbox 0.2.0 ([907b54d](https://github.com/phamvuhoang/ralph/commit/907b54d030e7e9811caea0f0b98ae29d5ec3280d))
* **main:** release ralph-sandbox 0.2.0 ([c806b7b](https://github.com/phamvuhoang/ralph/commit/c806b7bff442bb920f6db225e0feacf7e5fc5f91))
* **main:** release ralph-sandbox 0.2.1 ([466ab60](https://github.com/phamvuhoang/ralph/commit/466ab60ec0dad58e02a62ff14fdd157b1b6ae194))
* **main:** release ralph-sandbox 0.2.1 ([4d390a1](https://github.com/phamvuhoang/ralph/commit/4d390a1497423b497b589adcf4a51d719acde583))
* **main:** release ralph-sandbox 0.2.2 ([b5de99b](https://github.com/phamvuhoang/ralph/commit/b5de99bc15df73c486db85f316deaa4f5e0e04d3))
* **main:** release ralph-sandbox 0.2.2 ([969e923](https://github.com/phamvuhoang/ralph/commit/969e9231ccefec39f3a574732215fa6923a9b246))
* **main:** release ralph-sandbox 0.2.3 ([bb32239](https://github.com/phamvuhoang/ralph/commit/bb3223933cfd621999cac19bc2da17481b1c425b))
* **main:** release ralph-sandbox 0.2.3 ([9c77768](https://github.com/phamvuhoang/ralph/commit/9c777686ddc5d23f3abac41989bdceb4a23d53cd))
* prepare repo for open-source release ([2970c34](https://github.com/phamvuhoang/ralph/commit/2970c34583f2a586d6554d0027292707cd8da070))
* release ralph 0.6.0 ([7ffb5e3](https://github.com/phamvuhoang/ralph/commit/7ffb5e3a6a11149f5540e446523e719aa5977c0d))
* release ralph-core@0.4.0 and ralph@0.4.0 ([d29e239](https://github.com/phamvuhoang/ralph/commit/d29e23916b6b3656be40a85f32df61d59e17fdeb))
* **release:** bump @daonhan/ralph-core and @daonhan/ralph to 0.6.1 ([aa04fbd](https://github.com/phamvuhoang/ralph/commit/aa04fbdb7fd49e2e3bb4e65caf0900da29143bf0))
* **release:** bump ralph and ralph-core to 0.6.2 ([5e90031](https://github.com/phamvuhoang/ralph/commit/5e9003109189b7696ff94fa61036d06b9f27b6c5))
* **release:** bump ralph and ralph-core to 0.6.3 ([ea1c006](https://github.com/phamvuhoang/ralph/commit/ea1c00615296e0433706257b23f0087030984374))
* **release:** commit remaining files for [@phamvuhoang](https://github.com/phamvuhoang) scope ([f29e00a](https://github.com/phamvuhoang/ralph/commit/f29e00a72e556ee99c77b964cbffee13f12afeea))
* **release:** drop ralph-sandbox image from release guards, status table, and CI ([7171fd8](https://github.com/phamvuhoang/ralph/commit/7171fd8b1488ece2718c306183260e75cbe491c4))
* **release:** switch npm scope to [@phamvuhoang](https://github.com/phamvuhoang) ([6373cfb](https://github.com/phamvuhoang/ralph/commit/6373cfbe8f5664525df3ecdfa0f9f67d32237415))
* remove dead docker scripts; route templates to ralph-core release ([51a26ff](https://github.com/phamvuhoang/ralph/commit/51a26ff0e8b0946448f3b95da7ce299902fda8e1))
* remove sandbox image, Dockerfile, and image CI/release wiring ([92b7164](https://github.com/phamvuhoang/ralph/commit/92b7164684a116c8f2afb8049c4149824b350db1))

## [0.6.3](https://github.com/daonhan/ralph/compare/ralph-core-v0.6.2...ralph-core-v0.6.3) (2026-06-05)


### Bug Fixes

* **ghafk:** fail loud on gh issue-fetch errors instead of false-completing ([74832b8](https://github.com/daonhan/ralph/commit/74832b80d44b3357c4d197e6d282048336d8cfa4))
* **release:** revert premature 0.6.3 bump so release-please anchors on 0.6.2 ([d290a65](https://github.com/daonhan/ralph/commit/d290a65b60abe427c6a38b266a0cc2b1eac1ac5c))
* **release:** revert premature 0.6.3 bump so release-please anchors on 0.6.2 ([add45ea](https://github.com/daonhan/ralph/commit/add45eab9068fce3168f9b16ede195f8a7c36ed1))


### Miscellaneous Chores

* **release:** bump ralph and ralph-core to 0.6.3 ([ea1c006](https://github.com/daonhan/ralph/commit/ea1c00615296e0433706257b23f0087030984374))

## [0.6.2](https://github.com/daonhan/ralph/compare/ralph-core-v0.5.1...ralph-core-v0.6.2) (2026-06-03)

### Features

* **core:** keep AFK runs awake by default with per-OS sleep inhibitors
* **core:** add per-stage retry/backoff, `--detach` background mode, and `--notify` completion/failure OS toast + bell
* **core:** wire `RALPH_MODEL` through to the sandbox `claude --model`
* **core:** print a cli + core version banner at loop init

### Bug Fixes

* **core:** abort active Docker work on SIGINT/SIGTERM and clean up AFK signals
* **core:** grace-timer recovers from a post-result claude-CLI hang
* **core:** warn on the docker.sock mount (root-equivalent host access)
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
