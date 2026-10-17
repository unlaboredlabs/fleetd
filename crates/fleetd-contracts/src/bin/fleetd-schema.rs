//! Writes the JSON Schemas to `crates/fleetd-contracts/schema/`, or to the directory given as the first argument.

use std::path::PathBuf;

fn main() -> std::io::Result<()> {
    let dir = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("schema"));
    std::fs::create_dir_all(&dir)?;
    let schemas = fleetd_contracts::schema::render_json_schemas();
    for (file, text) in &schemas {
        std::fs::write(dir.join(file), text)?;
    }
    println!("wrote {} schemas to {}", schemas.len(), dir.display());
    Ok(())
}
