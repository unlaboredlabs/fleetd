---
title: Payments and sign-ins
description: Let a bot pay with a card, fill in private details, and stay signed in to sites.
---

A bot's lead can book, buy and sign in on the web for you, and any agent can sign in. It never sees your card, your ID numbers or your passwords.

## Pay with a card {#purchases}

1. Add a card to the [Vault](/docs/vault). Use a virtual card with a monthly limit.
2. Open the bot's settings. Under **Payments**, click **Pick a card…** and choose it.

Then ask the lead to book or buy something. At the checkout:

1. The lead records the shop, the total and what's in the basket. The chat shows it.
2. fleetd fills the card into the checkout, once, on that shop only.
3. The lead checks the total and pays. The chat says "Paid 129.90 EUR at Hotel Adlon with Visa ••4242".

You aren't asked first. If your bank wants to confirm (3-D Secure, a code), the lead hands the browser to you.

**Payments** in the bot's settings lists every purchase.

### What's protected {#purchase-limits}

- The lead never sees the card's number, expiry or code. Filled fields show as dots in recordings and screenshots.
- A fill works only on the shop the lead named, within 15 minutes.
- Paying exchanges, brokers and money-transfer services is refused.

## Sign in with a secure form {#sign-in-form}

When an agent's browser reaches a sign-in page, it fills the login from the [Vault](/docs/vault) by itself. When the
vault has no login for that site:

1. The chat shows a card: **Sign in to** the site, with its address, and **Open**.
2. Open it on the desktop, the web app or your phone. Enter the email or username and the password.
3. Leave **Securely save to Vault** ticked to keep the login for next time, then click **Submit**.

fleetd types it into the page's fields on that site and submits the form. If the site then asks for a code it texted
or emailed you, a second card asks for it the same way. Never in the chat.

- The agent never sees, logs or records what you enter. From the fill on, its browser refuses reading it back.
- Values go only to the site the page was on when the agent asked, and its own frames.
- Saved, it's a login in the workspace vault for that site, and the next sign-in there needs no form.

A captcha, a passkey or approving the sign-in on another device can't be done in a form: for those the agent hands
you its browser instead.

## Private details {#secure-input}

Some forms need something only you should give, such as a passport number or a code texted to you.

1. The chat shows a sealed field naming the site and what it needs.
2. Type the value in the desktop app.
3. fleetd types it straight into that field on that site, once.

The value never reaches the lead, the chat or any log. A detail stored in 1Password can be filled from there instead, without asking.

## Stay signed in {#sign-ins}

A bot with no repo keeps its browser signed in. Sign in to a site once, yourself or through the lead, and it stays signed in next time.

- Cookies and site data are kept, in a browser profile of that bot's own, on its machine.
- History, saved passwords and form entries aren't kept.
- Other bots and agents never share it: each agent starts with a fresh, empty browser.

To sign out of everything, open the bot's settings and click **Forget sign-ins…** under **Sign-ins**. To sign out of one site, ask the lead.

Deleting the bot deletes its sign-ins too.
