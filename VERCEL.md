# Deploy Super Snoopers to Vercel (easiest path)

This is a static game (HTML + JS + assets) plus one tiny serverless API for
worldwide matchmaking. Total time: ~5 minutes.

The code is already on GitHub: **https://github.com/Potato-Lover98/Super_Snoopers**

---

## Step 1 — Import the repo into Vercel

1. Go to **https://vercel.com** and **Log in with GitHub**.
2. Click **Add New… → Project**.
3. Find **Super_Snoopers** in the list → click **Import**.
   (If you don't see it: **Adjust GitHub App Permissions** → give Vercel access to the repo.)
4. On the configure screen leave **everything default**:
   - Framework Preset: **Other**
   - Build Command: **(empty)**
   - Output Directory: **(empty)**
   - Install Command: **(empty)**
5. Click **Deploy**.

After ~30 seconds you get a live URL like `https://super-snoopers.vercel.app`.
The game is already playable here. Share that link — anyone in the world can play.

> Quick Match works right away by **hosting a room**, and **Create Room / share
> the code** always works. To let Quick Match auto-find strangers' rooms
> worldwide, do Step 2.

---

## Step 2 — Add the matchmaking database (Upstash Redis, free)

The `/api/rooms` server needs a small Redis store to track live rooms.

1. In your Vercel project, open the **Storage** tab (top of the project page).
2. Click **Create Database → Upstash → Redis** (it's in the Marketplace, free tier).
3. Pick a name + region (any region is fine) → **Create**.
4. When asked, **Connect** it to the **Super_Snoopers** project, all environments
   (Production, Preview, Development).
   - This automatically adds the env vars `UPSTASH_REDIS_REST_URL` and
     `UPSTASH_REDIS_REST_TOKEN` — you don't type anything.
5. Go to the **Deployments** tab → on the latest deployment click the **⋯** menu
   → **Redeploy** (so the new env vars take effect).

Done. Global Quick Match is now live.

---

## Step 3 — (optional) Verify it works

- Open the URL on two devices (or two browser tabs):
  - **Play** on both → they should land in the same room and see each other.
  - Or **Play with Friends → Create Room**, copy the code/URL, **Join** on the other.
- Check the API directly: visit `https://YOUR-URL/api/rooms?action=list`
  - Returns `{"rooms":[...]}` → matchmaking is working.
  - Returns a 500 error → Upstash isn't connected yet (redo Step 2).

---

## Updating the game later

Every time you `git push` to the `main` branch, Vercel **auto-redeploys**.
No extra steps.

---

## Notes / limits

- **Gameplay is peer-to-peer** (WebRTC). Vercel only does matchmaking, so there
  are no per-player server costs — the free Hobby plan is plenty.
- **Max 5 players per room** (enforced by the host and the matchmaking server).
- A few players on very strict mobile/corporate networks may fail to connect
  P2P (no TURN relay). If that becomes a problem, a TURN server can be added —
  ask and it can be wired in.
- Vercel **cannot** run a always-on WebSocket game server (functions are
  short-lived), which is why gameplay is P2P and only matchmaking is serverless.
  This is the standard, cheapest architecture for a browser .io-style game.
