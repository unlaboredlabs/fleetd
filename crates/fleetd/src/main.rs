// The shipped Linux binary is static musl, built with zig, whose malloc never gives small blocks back: 2,000 chat sends
// left a hub at 290 MB for good. jemalloc returns them at the same speed, configured in .cargo/config.toml. Every other
// target keeps its system's allocator.
#[cfg(all(target_os = "linux", target_env = "musl"))]
#[global_allocator]
static ALLOCATOR: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

fn main() -> std::process::ExitCode {
    fleetd::cli::main()
}
