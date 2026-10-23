interface ImportMetaEnv {
  /** "1" only in the QA build (`pnpm qa:build`), which carries the error boundaries' probe. */
  readonly VITE_FLEETD_QA?: string;
}
