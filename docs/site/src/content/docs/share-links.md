---
title: Share links
description: Open an agent's dev server in your browser or on your phone, signed in, with hot reload.
---

A share link turns a port on one of the workspace's machines into an address such as `https://k7f3q9m2x8ab.preview.example.com`. Open it on your computer or your phone and you see the running app, hot reload included. Only signed-in members of the workspace can open it. There are no public links.

## How agents use them {#agents}

An agent that starts a dev server calls `share_port` with the port. The chat then shows an **Open preview** card. Tap it, and the app signs you in on the link and opens it in your browser.

- The port has to be on the agent's own machine. An agent can't share a port on another machine.
- Sharing the same port again renews its link rather than making a new one.
- Each link has a random name. Nobody picks it.

## Who can open one {#who}

- **A member, from the app.** **Open preview** gets a one-time code from the workspace. The code takes the browser to the link and leaves a cookie that works only on that link. The cookie lasts an hour, and each visit renews it.
- **Someone who isn't signed in.** Opening the address in a browser shows **Sign in to open this preview**. **Open in fleetd** hands it to the desktop or phone app, which signs you in and opens it again.
- **Someone who isn't a member**, or who has been removed from the workspace, is refused. A removed person's cookie stops working at once.

The dev server never sees the link's cookie. It sees requests as if they came from its own machine (`Host: localhost:<port>`), so dev servers that only accept localhost, like Vite's default, work as they are.

## How long they last {#expiry}

A link lasts 2 hours unless the agent asks for less or more, up to 24. **Renew** gives it another 2 hours from now. **Stop** ends it at once, and its hot-reload connections close. A workspace can have 20 links open at a time.

## Settings {#settings}

**Settings › Workspace › Share links** is for owners and admins:

- **Share links**: turns the feature off for the workspace or back on. While it's off, links don't open and agents can't make new ones.
- **Preview address**: on a self-hosted workspace, where links live (see below).
- **Open links**: each link with Open, Renew and Stop.
- **Share a port**: shares a dev server already running on one of the workspace's machines.

On the phone, **Settings › Share Links** lists the open links. Tap one to open or stop it. Owners and admins also get the switch there.

Making, opening, renewing and stopping a link, and turning the feature on or off, are all recorded in the [audit log](/docs/audit-log), under **Share links**.

## On a self-hosted workspace {#self-hosted}

The workspace serves the links itself. fleetd runs nothing for it. It needs:

1. **A name of its own, with a wildcard.** For example `preview.example.com`, with `*.preview.example.com` pointing at the workspace's machine. Don't use the workspace's own address or a parent of it: previews must never share an origin with the workspace. Point the record at a tailnet address (`100.x.y.z`) to keep links inside your tailnet, or at a public one to open them anywhere you can sign in.
2. **A wildcard certificate** for that name. Browsers need HTTPS for the link's cookie.
3. **A proxy** in front of the workspace that passes every `*.preview.example.com` request, WebSockets included, to the workspace's own port with its Host header unchanged.

Caddy covers 2 and 3 in one file. Its wildcard certificate needs a DNS challenge, so build Caddy with your DNS provider's module (for example `xcaddy build --with github.com/caddy-dns/cloudflare`):

```
*.preview.example.com {
  tls {
    dns cloudflare {env.CLOUDFLARE_API_TOKEN}
  }
  reverse_proxy 127.0.0.1:4790
}
```

Then set **Settings › Workspace › Share links › Preview address** to `https://preview.example.com`.

Tailscale Serve doesn't give wildcard names, so it can't serve share links on its own. Keep using it for the workspace's own address, and put Caddy (or another proxy) in front for the previews.

To try links on the workspace's own machine without DNS, set the preview address to `http://localhost:4790`. Chrome opens `http://<name>.localhost:4790` with no setup.

## On fleetd cloud {#cloud}

Nothing to set up. Links live under fleetd's own preview domain and open after you sign in with your fleetd account. They work for dev servers on your own machines and on fleetd's computers.
