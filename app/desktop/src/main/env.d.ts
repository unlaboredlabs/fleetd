interface ImportMetaEnv {
  /**
   * "1" only in the unpublished CI test build (`MAIN_VITE_FLEETD_TEST_BUILD=1 pnpm build`); electron-vite inlines it
   * at build time, so a release build has no way to turn it on.
   */
  readonly MAIN_VITE_FLEETD_TEST_BUILD?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
