# Setup checklist (accounts and inputs — only Ashraf can do these)
1. **Dedicated SIM/number** (never the personal number). WhatsApp Business on a real phone that stays online. Use it by hand like a normal business line for several days before pairing. If the number is still locked by a previous holder, wait for the reset or buy a fresh SIM that was never on WhatsApp.
2. **Google Cloud**: new project → billing → enable *Places API (New)* → API key restricted to the server IP + Places API only → budget alert. Put the daily/monthly caps in settings (defaults $3 / $40).
3. **Anthropic API key**: a separate key for this project with a spend limit.
4. **Telegram**: create a bot with @BotFather (token) and get your numeric user id (e.g. from @userinfobot).
5. **VPS**: 2 vCPU / 4 GB, Ubuntu LTS (Hetzner CX23 ≈ €6/mo or Hostinger KVM 2 — verify price on the day). SSH key only; firewall 80/443 + SSH; unattended upgrades; fail2ban.
6. **GitHub**: create private repo `mrvoroo/magmafy-outreach`, then `git subtree split -P outreach-system -b outreach-only` from the CRM-source clone and push it there.
7. **Cloudflare**: DNS `outreach.<domain>` → VPS; Cloudflare Access in front of the admin page.
8. **CRM**: deploy the outreach door (CRM `DEPLOY-CHECKLIST.md` §7), copy the key into `CRM_OUTREACH_KEY`, set `CRM_URL` to the web-app URL.
9. Fill `deploy/.env` from `.env.example` (chmod 600). `docker compose -f deploy/docker-compose.yml up -d --build`.
