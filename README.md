# fleetd

An open-source software factory. Send a one-line order from the desktop app; a lead agent for the project turns it
into a brief and runs Claude Code sessions across your machines, asks you only what it must, and reports "done" only
after fleetd has checked the work itself.

```sh
curl -fsSL https://fleetd.sh | sh
```

Then run `fleetd init`. Docs: **[fleetd.sh/docs](https://fleetd.sh/docs)**.

## Contributing

One Cargo workspace, built with a recent stable Rust (`cargo build --release -p fleetd`). Layout, checks, the lab
suite and conventions: [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md). Report a vulnerability privately through
GitHub's security advisories.

## License

MIT
