interface ImportMetaEnv {
  /** True only under `electron-vite dev`; Vite inlines it. */
  readonly DEV: boolean;
  /**
   * "1" only in the unpublished CI test build (`MAIN_VITE_FLEETD_TEST_BUILD=1 pnpm build`); electron-vite inlines it
   * at build time, so a release build has no way to turn it on.
   */
  readonly MAIN_VITE_FLEETD_TEST_BUILD?: string;
  /** fleetd cloud's accounts origin (src/main/cloud/config.ts), inlined at build time; unset in releases. */
  readonly MAIN_VITE_FLEETD_ACCOUNTS_URL?: string;
  /** The WorkOS client id the cloud's sign-in page is opened with, inlined at build time; unset in releases. */
  readonly MAIN_VITE_FLEETD_WORKOS_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
