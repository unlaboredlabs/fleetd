//! Writes the JSON Schemas to `crates/fleetd-contracts/schema/` and the desktop app's TypeScript to
//! `app/desktop/src/shared/contracts/generated/`. `--check` writes nothing and fails on any difference, including a
//! hand edit to a generated file.

use fleetd_contracts::schema;

fn main() -> std::io::Result<()> {
    if std::env::args().nth(1).as_deref() == Some("--check") {
        let drift = schema::drift();
        if drift.is_empty() {
            println!("generated contracts are current");
            return Ok(());
        }
        for file in &drift {
            eprintln!("out of date: {file}");
        }
        eprintln!("fix: cargo run -p fleetd-contracts --bin fleetd-schema, then commit the result");
        std::process::exit(1);
    }
    let root = schema::repo_root();
    let sets = [
        (
            root.join("crates/fleetd-contracts/schema"),
            schema::render_json_schemas(),
        ),
        (root.join(fleetd_contracts::ts::TS_DIR), schema::render_ts()),
    ];
    for (dir, files) in sets {
        std::fs::create_dir_all(&dir)?;
        for (file, text) in &files {
            std::fs::write(dir.join(file), text)?;
        }
        println!("wrote {} files to {}", files.len(), dir.display());
    }
    Ok(())
}
