<div align="center">

<br />
<img src="app/frontend/public/wordmark-1024.png" alt="Eeronaut" width="75%">
<br />
<br />
<br />

**A locally-hosted web-based dashboard for managing Eero mesh networks**

<p>
<a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0--only-1e5aa8?style=flat-square" alt="license: AGPL-3.0-only"></a>
<img src="https://img.shields.io/badge/Python-%E2%89%A5%203.11-3776AB?logo=python&logoColor=white&style=flat-square" alt="Python 3.11 or newer">
<img src="https://img.shields.io/badge/FastAPI-backend-009688?logo=fastapi&logoColor=white&style=flat-square" alt="FastAPI: backend">
<img src="https://img.shields.io/badge/React-19-1f6f8b?logo=react&logoColor=white&style=flat-square" alt="React: 19">
<img src="https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white&style=flat-square" alt="TypeScript: 6">
<img src="https://img.shields.io/badge/Vite-8-646CFF?logo=vite&logoColor=white&style=flat-square" alt="Vite: 8">
<img src="https://img.shields.io/badge/Tailwind%20CSS-4-0e7490?logo=tailwindcss&logoColor=white&style=flat-square" alt="Tailwind CSS: 4">
</p>

<p>
<a href="https://ko-fi.com/bretteroo"><img src="https://img.shields.io/badge/-Support%20Eeronaut-13C3FF?style=flat-square&labelColor=555555&logo=data:image/svg%2Bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHBhdGggZmlsbD0iI2ZmZmZmZiIgZD0iTTEyIDIxcy03LjQtNC41LTkuNC05LjFDMS4xIDguMyAzLjMgNC42IDcgNC42YzIgMCAzLjYgMS4xIDUgMi45IDEuNC0xLjggMy0yLjkgNS0yLjkgMy43IDAgNS45IDMuNyA0LjQgNy4zQzE5LjQgMTYuNSAxMiAyMSAxMiAyMXoiLz48L3N2Zz4=" alt="Support Eeronaut"></a>
</p>

---

_Set sail for fun and adventure!_

_...without your phone!_

[📚 Features](#-features) | [🎨 Themes](#-themes) | [🚀 Get Started](#-get-started) | [💙 Contributions](#-contributions) | [👏🏻 Acknowledgements](#-acknowledgements) | [🔒 License](#-license)

</div>

---

# <img src="app/themes/sailing/assets/brand.png" style="height: 1.5em;"> Eeronaut
<div align="center">
<kbd><img src="docs/screenshots/eerish/dashboard.webp" alt="Eerish theme, Dashboard" width="260"></kbd>
<kbd><img src="docs/screenshots/eerish/airtime.webp" alt="Eerish theme, Airtime" width="260"></kbd>
<kbd><img src="docs/screenshots/eerish/clients.webp" alt="Eerish theme, Clients" width="260"></kbd>
</div>

<br />

Eeronaut brings browser-based management to Eero mesh networks.

A human designed Eeronaut and Claude Code built it.  Best to be up-front about these things.

Nearly every feature included in Eero's mobile apps is included in Eeronaut...plus some new ones!

Eeronaut is not affiliated with eero LLC or Amazon.com, Inc. and was created by an enthusiastic end user.

---

<a href="features"></a>
## 📚 Features

- 🖥️ **A real web interface**
  - Modern and responsive.  
- 🎨 **Fully themeable**
  - Ships with several!  Some nice.  Some not.  Build your own!
- 🧹 **Hides internal spam**
  - Not an eero Plus subscriber? Hide the disabled features that require it.  
- 🗺️ **Topology map**
  - See which devices are connected to which eeros at a glance.  
- ⚠️ **Restart warnings**
  - No more "Oh, I guess that toggle takes my network down for a bit."
- 📻 **Radio channels and airtime graphs**
  - View graphs of band assignments and airtime usage.  
- 🌐 **More DNS options**
  - Several external DNS providers now included.  
- 🔄 **Embeddded DDNS provider support**
  - Adds configs for several Dynamic DNS services.  
- 🚪 **IPv4 and IPv6 forwarding improvements**
  - Much less clunky than the mobile app.  
- 📈 **Speed tests against the speed you pay for**
  - Raise hell with your ISP when they don't deliver.  
- 🗣️ **Multilingual**
  - More languages than you have fingers.  
- ⚖️ **AGPL-3.0-only**
  - Because free software should stay that way.
- 🤖 **Guaranteed Non-Slop**
  - I built this because I wanted it for myself.  It took weeks of careful curation to get it to 1.0.  It is good.

## 🎨 Themes

Eeronaut ships with a modular theming system and a few themes to show what's possible.

You can make your own themes, or just ask your robot to do it.

Check [THEMES.md](THEMES.md) for more info.

<details open>
<summary><b>Eerish</b></summary>
<img src="docs/screenshots/eerish/eerish-spread.png" alt="Eerish theme, Dashboard">

<table>
<tr>
<td width="50%"><img src="docs/screenshots/eerish/dashboard.webp" alt="Eerish theme, Dashboard"><br>Dashboard</td>
<td width="50%"><img src="docs/screenshots/eerish/clients.webp" alt="Eerish theme, Clients, with a client's details open"><br>Clients, with a client's details open</td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/eerish/topology.webp" alt="Eerish theme, Topology"><br>Topology</td>
<td width="50%"><img src="docs/screenshots/eerish/airtime.webp" alt="Eerish theme, Activity > Airtime"><br>Activity &gt; Airtime</td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/eerish/security.webp" alt="Eerish theme, Security"><br>Security</td>
<td width="50%"></td>
</tr>
</table>

</details>

<details>
<summary><b>Sailing</b></summary>
<img src="docs/screenshots/sailing/sailing-spread.png" alt="Sailing theme, Dashboard, with Clients, Airtime, Security, and Topology behind it">

<table>
<tr>
<td width="50%"><img src="docs/screenshots/sailing/dashboard.webp" alt="Sailing theme, Dashboard"><br>Dashboard</td>
<td width="50%"><img src="docs/screenshots/sailing/clients.webp" alt="Sailing theme, Clients, with a client's details open"><br>Clients, with a client's details open</td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/sailing/topology.webp" alt="Sailing theme, Topology"><br>Topology</td>
<td width="50%"><img src="docs/screenshots/sailing/airtime.webp" alt="Sailing theme, Airtime"><br>Airtime</td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/sailing/security.webp" alt="Sailing theme, Security"><br>Security</td>
<td width="50%"></td>
</tr>
</table>

</details>

<details>
<summary><b>Liquid Glass</b></summary>
<img src="docs/screenshots/liquid-glass/liquid-glass-spread.png" alt="Liquid Glass theme, Dashboard, with Clients, Airtime, Security, and Topology behind it">

<table>
<tr>
<td width="50%"><img src="docs/screenshots/liquid-glass/dashboard.webp" alt="Liquid Glass theme, Dashboard"><br>Dashboard</td>
<td width="50%"><img src="docs/screenshots/liquid-glass/clients.webp" alt="Liquid Glass theme, Clients, with a client's details open"><br>Clients, with a client's details open</td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/liquid-glass/topology.webp" alt="Liquid Glass theme, Topology"><br>Topology</td>
<td width="50%"><img src="docs/screenshots/liquid-glass/airtime.webp" alt="Liquid Glass theme, Airtime"><br>Airtime</td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/liquid-glass/security.webp" alt="Liquid Glass theme, Security"><br>Security</td>
<td width="50%"></td>
</tr>
</table>

</details>

<details>
<summary><b>Harbor</b></summary>
<img src="docs/screenshots/harbor/harbor-spread.png" alt="Harbor theme, Dashboard, with Clients, Airtime, Security, and Topology behind it">

<table>
<tr>
<td width="50%"><img src="docs/screenshots/harbor/dashboard.webp" alt="Harbor theme, Dashboard"><br>Dashboard</td>
<td width="50%"><img src="docs/screenshots/harbor/clients.webp" alt="Harbor theme, Clients, with a client's details open"><br>Clients, with a client's details open</td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/harbor/topology.webp" alt="Harbor theme, Topology"><br>Topology</td>
<td width="50%"><img src="docs/screenshots/harbor/airtime.webp" alt="Harbor theme, Airtime"><br>Airtime</td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/harbor/security.webp" alt="Harbor theme, Security"><br>Security</td>
<td width="50%"></td>
</tr>
</table>

</details>

<details>
<summary><b>Winksys</b></summary>

<img src="docs/screenshots/winksys/winksys-spread.png" alt="Winksys theme, Status, Router, with Local Network, Wireless, Firewall, and Basic Setup behind it">

<table>
<tr>
<td width="50%"><img src="docs/screenshots/winksys/router.webp" alt="Winksys theme, Status > Router"><br>Status &gt; Router</td>
<td width="50%"><img src="docs/screenshots/winksys/local-network.webp" alt="Winksys theme, Status > Local Network, with a client's details open"><br>Status &gt; Local Network, with a client's details open</td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/winksys/wireless-status.webp" alt="Winksys theme, Status > Wireless"><br>Status &gt; Wireless</td>
<td width="50%"><img src="docs/screenshots/winksys/firewall.webp" alt="Winksys theme, Security > Firewall"><br>Security &gt; Firewall</td>
</tr>
<tr>
<td width="50%"><img src="docs/screenshots/winksys/basic-setup.webp" alt="Winksys theme, Setup > Basic Setup"><br>Setup &gt; Basic Setup</td>
<td width="50%"></td>
</tr>
</table>

</details>

## 🫸🏻 What it isn't

Eeronaut **isn't** the local web controller we've all been waiting years for.  It's the closest thing possible, I think.

It might be easier to think of Eeronaut as a locally-hosted front end for the eero cloud.

Eero's own mobile apps are slaves to the cloud.  Their Android and IOS apps make changes on the eero cloud, and those changes are then pushed down to your eero devices.  That's just how they work.  Eeronaut does the same thing.

There isn't a route to make changes locally to your Eero devices (as far as anyone knows), and most discovered local calls to Eero devices are read-only.

Eeronaut is also not a way to get eero Plus features for free. Eero Plus features are disabled **unless** a subscription is detected.  

## 🚀 Get Started

Docker is the recommended way to run Eeronaut: one command to install, one to update, and nothing else to set up on the machine.

Images are provided for `linux/amd64` and `linux/arm64`.  Eeronaut is lightweight enough for Raspberry Pi.

> [!IMPORTANT]
> **Eeronaut requires a native Eero account.**<br />If you sign in to the Eero app with your Amazon credentials, you'll first need to send yourself an invitation to manage your Eero account via the Eero Mobile app:
> * Settings / User Permissions / + / Invite admin
> * Accept the invitation, and you'll then be able to login to Eeronaut using that email address or phone number.

<details>
<summary><b>Install With Docker (recommended)</b></summary>
  
### Install Eeronaut
  
  * Install Docker.
  * Download [`docker-compose.yml`](docker-compose.yml) into a folder of its own.
  * Edit it, replacing `</path/to/data>` with the directory you'd like to hold Eeronaut's data.<br />`/home/<username>/.config/eeronaut` is recommended, but you do you, Boo.
  * Then, from the folder holding `docker-compose.yml`:

```
docker compose up -d
```

Find it at <http://localhost:3340>. (Get it?)

### Future Updates

From the same folder:

```
docker compose pull && docker compose up -d
```
</details>

<details>
<summary><b>Install Without Docker</b></summary>

You'll need:
* Python 3.11 or newer, with its `venv` module. On Debian, Ubuntu, and Raspberry Pi OS that's a separate package: `sudo apt install python3-venv`.
* Node.js 22.12 or newer (or 20.19 or newer on Node 20), to build the interface.
* git.

### Install Eeronaut
```
sudo mkdir /opt/eeronaut
sudo chown $USER: /opt/eeronaut
git clone https://github.com/Bretteroo/Eeronaut.git /opt/eeronaut
cd /opt/eeronaut/app/frontend
npm ci
npm run build
cd ../backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/pip install --no-deps -e .
```
### Tell it to stick around
To start Eeronaut when the machine boots (and keep it running), we turn to good ol' systemd.

Save this as `/etc/systemd/system/eeronaut.service`:

```
[Unit]
Description=Eeronaut
After=network-online.target
Wants=network-online.target

[Service]
DynamicUser=yes
StateDirectory=eeronaut
Environment=EERONAUT_DATA_DIR=/var/lib/eeronaut
WorkingDirectory=/opt/eeronaut/app/backend
ExecStart=/opt/eeronaut/app/backend/.venv/bin/uvicorn eeronaut.main:app --host 0.0.0.0 --port 3340
Restart=on-failure
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

Then `sudo systemctl daemon-reload && sudo systemctl enable --now eeronaut`.

Find it at <http://localhost:3340>. (Get it?) To use a different port, change `--port` in the `ExecStart` line.

### Future Updates

```
cd /opt/eeronaut && git pull
cd app/frontend && npm ci && npm run build
cd ../backend && .venv/bin/pip install -r requirements.txt && .venv/bin/pip install --no-deps -e .
sudo systemctl restart eeronaut
```
### Just use Docker

Way easier.
</details>

## 💙 Contributions

Issue reports are encouraged.  If you've got ideas for improvements or find bugs, please <a href="../../issues/new/choose">open an issue</a>.

## 👏🏻 Acknowledgements

There are a few other projects in this space.  Give them a try!

🔹 <a href="https://github.com/fulviofreitas/eero-ui">Eero UI</a> by Fulvio Freitas  
🔹 <a href="https://github.com/xrvk/eero-dashboard">eero Dashboard</a> by xrvk  
🔹 <a href="https://github.com/EnricoFlammini/Dashboard_EERO">eero Custom Dashboard</a> by Enrico Flammini

## 🔒 License

This project is licensed under AGPL-3.0-only: the GNU Affero General Public License, version 3, and no later version. The full text is in
[LICENSE](LICENSE).

Eeronaut is not affiliated with, endorsed by, or supported by eero LLC.  "eero" is a trademark of Amazon Technologies, Inc.
