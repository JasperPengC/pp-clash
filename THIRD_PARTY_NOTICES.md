# Third-party notices

PP Clash is licensed under AGPL-3.0-only. It bundles or depends on the following third-party components:

- **mihomo** — GPL-3.0. The kernel binary is distributed in `src-tauri/resources/kernel.zip`.
  Source: https://github.com/MetaCubeX/mihomo
- **Sub-Store** — AGPL-3.0. The local service bundles the complete engine from [2.44.16](https://github.com/sub-store-org/Sub-Store/tree/2.44.16), with error reporting and execution tracing adaptations recorded in `scripts/sub-store/strict-errors.patch`. The subscription processor also includes the unmodified upstream browser module `proxy-utils.esm.mjs`; SHA-256: `b4fb781f727c282be2ef204097b664b4d63ee6e39d48f0e74d39da09dbdd0a7f`. Source and dependency lock checksums: `scripts/sub-store/upstream-lock.json`. License: `licenses/sub-store.txt`.
- **Node.js 24.18.0** — MIT and bundled third-party licenses. The Sub-Store service uses the complete Node.js runtime. Desktop distribution checksums are recorded in `scripts/sub-store/runtime-lock.json`; Android source, NDK, and patch checksums are recorded in `scripts/sub-store/android-runtime-lock.json`. License: `licenses/node.txt`; platform runtime packages also include their `LICENSE`, with Android toolchain notices where applicable. https://github.com/nodejs/node
- **Tauri** — MIT OR Apache-2.0. https://github.com/tauri-apps/tauri
- **React / React DOM** — MIT. https://github.com/facebook/react
- **Vite** — MIT. https://github.com/vitejs/vite
- **Zustand** — MIT. https://github.com/pmndrs/zustand
- **Phosphor Icons** — MIT. Selected Regular icons, vendored at commit `2b75f3ad12b420c9504ef05df8d2564a28f8500e`; license: `licenses/phosphor-icons.txt`. https://github.com/phosphor-icons/core
- **js-yaml** — MIT. https://github.com/nodeca/js-yaml

Full dependency license metadata is available in `package-lock.json` and `src-tauri/Cargo.lock`.
