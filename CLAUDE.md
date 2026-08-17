# PROJECT RULES — Live Bridge (SRT + RTMP Streaming Server)

## Non-negotiable rules
1. NEVER commit secrets, passphrases, stream keys, API keys, or .env files to git. Always use .env + .gitignore.
2. NEVER expose the dashboard, database, or internal SRS API ports directly to the internet without at least network-level restriction (firewall/VPN) — only Nginx (443), SRT (9000/udp), and RTMP (1935/tcp) should be reachable, and 443 should be restricted to known IPs or a VPN where possible since there is no app-level login.
3. NEVER use root user inside Docker containers. Create and use non-root users in every Dockerfile.
4. NEVER run `docker-compose down -v` or any destructive command without explicitly telling me first and waiting for confirmation.
5. NEVER auto-generate or hardcode default passwords/stream keys for SRT/RTMP. Generate strong random values, put them in .env, and tell me what they are.

## Code quality rules
6. Every service must have health checks in docker-compose.
7. Every container must have `restart: unless-stopped`.
8. All backend endpoints must validate/sanitize input — no raw string concatenation into shell commands or SQL queries.
9. Write structured JSON logs, not plain text, for stream events (SRT and RTMP) and dashboard access.
10. Test every new feature manually (show me the command/output) before moving to the next step.

## Process rules
11. Before writing code, briefly explain your plan for that step and wait for my go-ahead if it involves: opening new ports, changing dashboard access/exposure, or modifying restart/systemd behavior.
12. After each major step, give me a short summary of what changed and how to test it.
13. If unsure about a security-sensitive decision (port exposure, encryption, key handling), stop and ask instead of guessing.
14. Do not install additional system packages/dependencies beyond what's needed — list what's being installed and why.

## Branding
15. Use "Live Bridge" as the project name consistently — in the dashboard title, README, docker-compose project name, and systemd service name (livebridge.service).

## Documentation rules
16. Keep the README up to date after every major change.
17. Document every environment variable in a `.env.example` file (placeholder values only, never real secrets).

## Progress tracking & session continuity
18. At the start of every session, first read PROGRESS.md in the project root before doing anything else. This file is the source of truth for what phase the project is in and what's already been built.
19. If PROGRESS.md does not exist yet, create it using the template below before starting any work.
20. Break the build into phases (see Phase Overview in the template). Do not invent new phases mid-session without updating PROGRESS.md to reflect it.
21. After completing any meaningful chunk of work (checkpoints within a phase count too, not just full phases), update PROGRESS.md immediately with: what was done, what was tested and how, what's still pending, and any decisions/tradeoffs made that I should know about.
22. Never mark a phase as "Complete" in PROGRESS.md unless it has been tested and I've confirmed it works. Use "In Progress" or "Needs Verification" otherwise.
23. If you hit a blocker, uncertainty, or need my input, log it under "Open Questions / Blockers" in PROGRESS.md, not just in chat — chat history may not persist, this file must.
24. Never delete past entries in PROGRESS.md — append new updates with a timestamp. This file is a running log, not a status snapshot.

## Supabase-specific rules
25. NEVER expose any Supabase key (service role or anon) to the frontend — since there's no app-level auth, all Supabase access must go through the backend API only.
26. Enable Row Level Security (RLS) on every Supabase table regardless, as defense-in-depth even though access is backend-only.
27. Do not route actual media/stream data through Supabase — it is for metadata and logs only. The SRT/RTMP core stays fully local for reliability.
28. Keep Supabase migrations in a /supabase/migrations folder and document schema changes in PROGRESS.md under the relevant phase.
29. If Supabase is unreachable, the dashboard should degrade gracefully (e.g. show a "history unavailable" state) — it must NEVER take down the SRT/RTMP ingest itself.

---

### PROGRESS.md template (create this if missing)

\`\`\`markdown
# Live Bridge — Progress Log

## Current Phase
Phase X: [name] — [Not Started / In Progress / Needs Verification / Complete]

## Phase Overview
- [ ] Phase 1: SRT core setup
- [ ] Phase 2: RTMP support
- [ ] Phase 3: Backend API + WebSocket server
- [ ] Phase 4: Dashboard frontend
- [ ] Phase 5: Docker Compose wiring
- [ ] Phase 6: Nginx + HTTPS
- [ ] Phase 7: Relay/bridging (SRT<->RTMP, external platforms)
- [ ] Phase 8: Supabase integration (data layer, RLS policies)

## Log
### [YYYY-MM-DD HH:MM] — Phase X update
- What was done:
- What was tested / how:
- What's still pending:
- Decisions/tradeoffs made:

## Open Questions / Blockers
- [ ] (none yet)
\`\`\`