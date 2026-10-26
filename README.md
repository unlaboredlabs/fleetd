# fleetd

<!-- The showcase's last frame; the recording itself plays on https://fleetd.sh (site/README.md). -->
[![The fleetd app after one request ran through: you asked to let shoppers save their cart, the lead split it between two writers with a reviewer per PR, and the panel's merge line shows the first PR merged](site/showcase-light.jpg)](https://fleetd.sh)

fleetd runs Claude Code on your machines: you type what you want, and it plans the work, runs the agents, opens pull
requests it has checked, and asks you only about real decisions.

```sh
curl -fsSL https://fleetd.sh | sh
```

**You need:** macOS or Linux x64, the `claude` CLI logged in (fleetd uses your own claude setup, including any proxy
in `~/.claude/settings.json`), `git`, and `gh` for pull requests. About a minute later the hub runs on this machine,
the app is paired, and you send the lead your first message.

Docs: [fleetd.sh/docs](https://fleetd.sh/docs)<br>
Contributing: [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)<br>
License: MIT
