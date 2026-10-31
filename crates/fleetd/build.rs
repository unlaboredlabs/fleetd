//! Lists the hub's migrations, src/hub/store/migrations/<prefix>_<name>.sql, in the order of their prefixes, as
//! `MIGRATIONS` in $OUT_DIR/migrations.rs, each named by its file name without `.sql`. The build fails on a file not
//! of that form or two with one prefix.

use std::{env, fs, path::Path};

const DIR: &str = "src/hub/store/migrations";

fn main() {
    println!("cargo:rerun-if-changed={DIR}");
    let mut files: Vec<(u64, String)> = Vec::new();
    for entry in fs::read_dir(DIR).expect("the migrations directory") {
        let name = entry
            .expect("a migrations entry")
            .file_name()
            .into_string()
            .expect("a UTF-8 file name");
        // A prefix is 4 digits for a migration from before one file each (0001..0086), 12 (YYYYMMDDHHMM) after.
        let prefix = name
            .strip_suffix(".sql")
            .and_then(|stem| stem.split_once('_'))
            .filter(|(prefix, rest)| {
                matches!(prefix.len(), 4 | 12)
                    && prefix.bytes().all(|b| b.is_ascii_digit())
                    && !rest.is_empty()
                    && rest
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
            })
            .map(|(prefix, _)| prefix.parse().unwrap())
            .unwrap_or_else(|| {
                panic!("{DIR}/{name}: a migration is named YYYYMMDDHHMM_snake_case_name.sql")
            });
        files.push((prefix, name));
    }
    files.sort();
    for pair in files.windows(2) {
        if pair[0].0 == pair[1].0 {
            panic!(
                "{DIR}: {} and {} share a prefix; give the newer one a later one",
                pair[0].1, pair[1].1
            );
        }
    }
    let mut out = String::from("pub(crate) const MIGRATIONS: &[Migration] = &[\n");
    for (_, name) in &files {
        let stem = name.strip_suffix(".sql").unwrap();
        out.push_str(&format!(
            "    Migration {{ name: \"{stem}\", sql: include_str!(concat!(env!(\"CARGO_MANIFEST_DIR\"), \"/{DIR}/{name}\")) }},\n"
        ));
    }
    out.push_str("];\n");
    fs::write(
        Path::new(&env::var("OUT_DIR").unwrap()).join("migrations.rs"),
        out,
    )
    .unwrap();
}
