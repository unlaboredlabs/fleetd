// The sessions the Sessions fixture's hub serves, by name, shared with the QA registry's routes. Ids as the node mints
// them: "B" and 32 hex digits.
export const SESSION = {
  checkout: "B68722f97b065412024c7cda6c636fd9a",
  payouts: "B9a63189230ff64d06936e60523503180",
  share: "Bda813e7bb3877f4fca5494357cb97cbf",
  pricing: "B1568621fc635262160b1d3c91dbc8977",
  receipt: "B4e36494bac9c5c2b5bc9e430ab097914",
  saving: "Bf9fa4f882f29b35fe577a1519bf33cba",
  expired: "Bcabe309c063fd2c81d41bbfdf709c0cf",
  /** A person's own, from New screen. */
  mine: "B5e2c4a6f8d0b1a3c5e7f9d1b3a5c7e9f",
  /** A person's own iOS simulator on the Mac, live and theirs. */
  phone: "B3c5e7a9b1d3f5a7c9e1b3d5f7a9c1e3d",
} as const;
