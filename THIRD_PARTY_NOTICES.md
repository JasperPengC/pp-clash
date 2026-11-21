# Third-party notices

PP Clash is licensed under AGPL-3.0-only. It bundles or depends on the following third-party components:

- **mihomo** — GPL-3.0. The kernel binary is distributed in `src-tauri/resources/kernel.zip`.
  Source: https://github.com/MetaCubeX/mihomo
- **Sub-Store** — AGPL-3.0. The subscription processor bundles the unmodified upstream browser module `proxy-utils.esm.mjs` from [2.44.16](https://github.com/sub-store-org/Sub-Store/tree/2.44.16). SHA-256: `b4fb781f727c282be2ef204097b664b4d63ee6e39d48f0e74d39da09dbdd0a7f`. License: `licenses/sub-store.txt`.
- **Tauri** — MIT OR Apache-2.0. https://github.com/tauri-apps/tauri
- **React / React DOM** — MIT. https://github.com/facebook/react
- **Vite** — MIT. https://github.com/vitejs/vite
- **Zustand** — MIT. https://github.com/pmndrs/zustand
- **Phosphor Icons** — MIT. Selected Regular icons, vendored at commit `2b75f3ad12b420c9504ef05df8d2564a28f8500e`; license: `licenses/phosphor-icons.txt`. https://github.com/phosphor-icons/core
- **js-yaml** — MIT. https://github.com/nodeca/js-yaml

Full dependency license metadata is available in `package-lock.json` and `src-tauri/Cargo.lock`.
