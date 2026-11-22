# Start on your laptop (assisted mode — no WhatsApp automation)
In assisted mode the system finds leads, writes the messages, plans the day, and sends you a wa.me link on Telegram; YOU tap it and send from the phone. Replies arrive on your phone, so you tell the system with `/replied <name> | <what they wrote>` (this stops follow-ups and classifies it). The laptop must be on and the program running during sending windows.

1. Install Node 22+ (nodejs.org, LTS) and git.
2. `git clone https://github.com/mrvoroo/magmafy-outreach.git && cd magmafy-outreach && npm ci`
3. Create a file named `.env` in that folder (never commit it):
```
SEND_ENABLED=true
CRM_URL=<Apps Script web-app URL ending in /exec>
CRM_OUTREACH_KEY=<the key from outreachSetupKey>
GOOGLE_PLACES_API_KEY=<key>
ANTHROPIC_API_KEY=<key>
TELEGRAM_BOT_TOKEN=<token from BotFather>
TELEGRAM_OWNER_ID=<your numeric Telegram id>
```
4. Get leads once: `npx tsx --env-file=.env src/main.ts source` (Riyadh, up to 120 leads).
5. Run it: `npx tsx --env-file=.env src/main.ts` (leave the window open). Dashboard: http://localhost:8080 (sign in with your CRM admin e-mail + the emailed code).
6. In Telegram send your bot `/start`, then `/mode assisted`, then `/status`.
7. Review the messages in the dashboard (Conversations / Quality) before sending the first one.
