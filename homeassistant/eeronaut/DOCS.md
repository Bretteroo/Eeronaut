# Eeronaut

Eeronaut is a web dashboard for eero mesh networks. This app runs it on your Home Assistant machine and puts it in the sidebar.

## Installing

1. In Home Assistant, go to **Settings > Apps** and choose **Install App**.
2. Open the menu at the top right, choose **Repositories**, and add `https://github.com/Bretteroo/Eeronaut`.
3. Find **Eeronaut** in the store, install it, and start it.
4. Turn on **Show in sidebar**, or use **Open Web UI**.
5. Sign in with your eero account. Eeronaut emails or texts you a code, the same way eero's app does.

Eeronaut needs a native eero account, one that signs in with an email address or phone number. If you sign in to the eero app with Amazon, first invite yourself as an admin from the eero app (**Settings > User Permissions > + > Invite admin**), accept the invitation, and then sign in to Eeronaut with that email address or phone number.

Only Home Assistant administrators see Eeronaut in the sidebar. It can restart your network and show your Wi-Fi password, so it isn't offered to other users.

## Using it from a phone or another computer

Eeronaut also answers on its own web port on your Home Assistant machine, 3340 by default, so any browser in the house can use it without signing in to Home Assistant: `http://homeassistant.local:3340`, or the machine's address in place of `homeassistant.local`. If you've changed the web port on the **Configuration** tab, use that number instead.

That page asks for Eeronaut's own password. Choose it from the sidebar first: open Eeronaut in Home Assistant, go to **Settings**, and choose a password on the Eeronaut card. Until you do, the web port can't be used, so nobody else on your network can choose one before you. If you forget it, set a new one the same way.

## The web port

The app uses the host's network, so its web port has to be free on the Home Assistant machine. If something else already uses 3340, change it on the app's **Configuration** tab and restart the app. The page in Home Assistant's sidebar doesn't use this port, so it keeps working whatever you choose.

## Your data

Eeronaut keeps its sign-in to eero, its password, and your settings in the app's data folder. Home Assistant backups include it.

## Support

Please report any issues you find with Eeronaut on [GitHub](https://github.com/Bretteroo/Eeronaut/issues).
