# Yarn HTTP forward proxy reproduction

This proof uses only Node.js built-ins, the supplied `package.tgz`, and a built Yarn CLI. It starts two loopback HTTP servers: a synthetic registry and a forward-only proxy that rejects CONNECT. All proxy credentials and registry data are synthetic. The harness closes its own servers after each run.

Base: `yarnpkg/berry` `ef16bb2e5826f2b4c342f387e4ac50fea86d4a51`.
Patched commit: `f1f3454f7d4c4267527e1bee972f9a8204660349`; tree: `e989302fcaa0ea4e3734a91490acd6c1316880c8`.

Build a CLI from each source checkout with:

```sh
node scripts/run-yarn.js build:cli
```

Keep the original and patched `packages/yarnpkg-cli/bundles/yarn.js` separately. Run this directory's portable proof:

```sh
node runtime.cjs baseline /absolute/path/to/original-yarn.js
node runtime.cjs candidate /absolute/path/to/patched-yarn.js
node runtime.cjs candidate-auth /absolute/path/to/patched-yarn.js auth-redirect
```

Each command writes a JSON receipt beside the harness and a task-specific fixture directory. The baseline harness command exits 0 only when Yarn itself exits 1 after CONNECT receives 501 and the registry sees no requests. Candidate commands exit 0 only when Yarn installs the real tarball and a separate Node process can require the installed package. The auth variant requires percent-encoded synthetic proxy credentials, follows a 302 between loopback hostnames, and verifies proxy credentials do not reach the registry.

Recorded original CLI SHA-256: `7ea8c970c4a1b55d42ff0803f30933382613f329fd916f7d3552017e323fe1f8`.
Recorded patched CLI SHA-256: `fde7c8f01a3778046a6b60971748cf286193dfa78a4de43a8bb310e40fa74b3f`.
Tarball SHA-256: `b471d4b6940961fa08e443ff58847a15d4cbed0fd47586795c0fd3b347f87b49`.
Portable harness SHA-256: `f5d5f4f8a81af7a6bc13a03afee19a4f2d3840fdd5359121098267166d24aa44`.

The final native acceptance fixtures also cover a TLS proxy that provides a certificate only for the expected SNI hostname. Current evidence has 16 passing proxy/HTTPS acceptance cases and 164 passing core unit tests. Running the two added forward-only tests against the original built CLI through the repository's `TEST_BINARY` option produces two failures with HTTP 501; the seven other cases are filtered out in that negative run.

The full external framework E2E suites and hosted multi-OS CI are not represented by these local counts. Early fixture/bootstrap failures and manual worker-generation diagnostics are retained privately and are not the final proof.

Recorded environment: Windows x64, Node.js v24.14.0. Source and dependency blobs are pinned in `final-source-manifest.json`; the committed build and actual process exits are in `committed-build-runtime-manifest.json`.

Pre-submit source checks and the exact post-commit configured CI conditionals are recorded separately. A conditional with zero matching paths is marked NOT_APPLICABLE, not a claim that its generator passed. No generated worker or CI configuration change is included in the patch.
