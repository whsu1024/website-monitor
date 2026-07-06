# Chrome Hearts Discord Stock Monitor

This checks the official Chrome Hearts shop category pages and posts to a Discord webhook when an item becomes newly available to purchase.

The default official pages are:

- `https://www.chromehearts.com/baccarat`
- `https://www.chromehearts.com/scents`
- `https://www.chromehearts.com/boxers-leggings`
- `https://www.chromehearts.com/intimates`
- `https://www.chromehearts.com/socks`

## Setup

1. Create a Discord webhook:
   - Discord server settings
   - Integrations
   - Webhooks
   - New Webhook
   - Copy Webhook URL

2. Install Node.js 18 or newer.

3. Copy `.env.example` to `.env` and add your webhook URL.

4. Run a dry check:

   ```bash
   npm run dry-run
   ```

5. Run a real check:

   ```bash
   export DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."
   npm run check
   ```

The first real run creates `state.json` and does not notify by default. After that, notifications are sent only when an item appears in stock that was not in the previous in-stock snapshot.

To alert on every currently in-stock item during the first run:

```bash
NOTIFY_ON_FIRST_RUN=true npm run check
```

## Schedule It

Cron example for every 5 minutes:

```cron
*/5 * * * * cd /path/to/chrome-hearts-monitor && DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..." npm run check >> monitor.log 2>&1
```

Use a polite interval. One to five minutes is usually enough for a personal stock monitor.

## Custom Pages

Override the category list with a comma-separated value:

```bash
CHROME_HEARTS_URLS="https://www.chromehearts.com/scents,https://www.chromehearts.com/socks" npm run check
```

## Notes

- This monitor only watches official `chromehearts.com` pages.
- It treats items without `OUT OF STOCK`, `Sold Out`, `Unavailable`, or `Coming Soon` text as purchasable.
- If Chrome Hearts changes its page markup, run `npm run dry-run` and inspect the output before relying on alerts.
