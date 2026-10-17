//! `fleetd update`: replaces this fleetd with a release build. Owned by the release work; this file only fixes the
//! API the CLI calls until that lands.

/// The version this binary reports: the release's (CI sets FLEETD_VERSION), else the crate's.
pub fn version() -> &'static str {
    option_env!("FLEETD_VERSION").unwrap_or(env!("CARGO_PKG_VERSION"))
}

#[derive(clap::Args, Clone, Debug, Default)]
pub struct UpdateArgs {
    /// Only say whether a newer release exists.
    #[arg(long)]
    pub check: bool,
    #[arg(long)]
    pub channel: Option<String>,
}

pub async fn run(_args: UpdateArgs) -> anyhow::Result<()> {
    anyhow::bail!("fleetd update is not in this build yet")
}
