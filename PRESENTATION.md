# Out of Signal — presentation brief

> **For Claude:** turn this into a slide deck (about 12–14 slides) for a hackathon pitch by **SzponTeam**.
> Read the **Style** section first, then build the slides from the **Slide plan**. Everything you need about
> the game is in the **Game facts** section; don't invent features that aren't listed there.

---

## Style

- **Look:** dark, tactical, monochrome — near-black background `#09090a`, off-white text `#f2f2f0`,
  grey secondary text `#b5b5b1`, thin grey hairlines `#36363c`. One accent only: signal green `#34d399`
  (used for player dots in the game), plus red `#ff7070` for danger moments (kills, "too far out").
  Monospace font (JetBrains Mono or similar) for numbers, labels and small caps headings; a clean sans
  (Inter) for body text. Small HUD-style corner brackets on key boxes are on-brand.
- **Transitions:** not too fancy, not too plain. Use a simple **fade** or short **push** between slides,
  nothing that spins or bounces. Inside slides, reveal bullet points **one by one on click**.
- **Hide some facts (build suspense):** on the slides marked **🔒 reveal**, show the question or a
  "???" placeholder first and reveal the answer on the next click. Keep the killer's secrets
  (who sees what) hidden until the slide that explains them, like the game itself does.
- **Text amount:** short lines, max ~5 bullets per slide, big numbers where we have numbers.
  Put longer explanations in the **speaker notes**, not on the slide.
- **Icons:** a radio antenna / tower (our app icon: white antenna with signal arcs on black),
  a phone, a map pin, a diamond for download points, a ballot for voting, a skull or crosshair for the killer.

---

## Game facts

### One-liner
**Out of Signal** is a real-world hide-and-seek game for 2–8 players on their phones: one secret
**killer** hunts the **seekers** across a real map, while the seekers download data, collect clues
and try to vote the killer out — and the phones sense each other with **ultrasonic sound**.

### Why it's different
- It's played **outside, in the real world** — the map is your actual park or neighbourhood.
- Phones detect each other **within ~2 metres using inaudible sound** (sonar), not just GPS,
  because GPS alone is 5–15 m off and can't tell "next to me" from "across the path".
- Nobody's screen gives their role away: **everyone has the same buttons**.
- Installable as an app on any phone straight from the website (PWA) — no app store.

### Setup
- One player **hosts** a lobby — and can only host **where they are standing** (GPS check).
- They pick the **centre** on a map and a **play area size**: Small **150 m**, Medium **300 m**,
  Large **500 m** radius. The circle is drawn live on the map.
- Other players only **see and can join lobbies whose play area they are standing inside**.
- When the host starts: **1 random killer**, everyone else is a seeker. Your role is shown for
  **5 seconds**, then hidden — so nobody can read it off your screen later.

### The map
- Everyone always sees **their own position**.
- **The killer sees everyone live**, and sees who is **carrying data** (a ring around them). 🔒
- **Seekers only get a "ping"** of everyone's position **once every 60 seconds**, and the dots fade
  until the next ping. 🔒
- The play area border is drawn on the map. It isn't a wall: stepping out a bit is fine, but going
  **more than 30 m past it for 10 seconds eliminates you**.

### Tasks: download data, power the towers
- The map has **towers** (A, B, C…) — **one per seeker** — and every tower has **3 download points**
  (A1, A2, A3), placed randomly inside the play area.
- Spots are checked against map data so they're **never in water or inside buildings**, always
  **next to a walkable path**.
- **Download:** stand at a point for **20 seconds** (walking away pauses it). You now carry that data.
- **Deliver:** walk it to **its own tower**. You carry **one piece at a time**.
- When a tower has **all 3 of its pieces**, it activates and gives a **clue** to whoever brought the
  last one: **"NAME is not the killer."** Then it empties and can be powered again. 🔒
- Every tower names a **different** seeker — so if all towers are powered, the seekers together
  know everyone who is innocent… which leaves only one person. 🔒
- The killer can do tasks too, to blend in.

### Touching phones (the sonar)
- Every phone plays its own **inaudible tone between 17.8 and 19.9 kHz** and listens with the
  microphone for the others. When another phone is loud enough for ~3.5 s, they are "touching".
- The sonar only switches on when someone is **within 15 m on GPS**, to save battery.
- **Share:** two players touching phones **copy their clues to each other** — both end up with all
  the clues either had.
- **Kill:** the killer touching a seeker's phone can **kill** them. 🔒
- **Vote:** players touching phones (A touches B, B touches C = one group) can call a **vote**.
  A player is out if **more than half of all living players** vote for them, so enough people have to
  physically come together. Voted-out players' roles are revealed.

### Timers
- Killer can't kill for the first **3 minutes**, then **30 s** recharge after each kill.
- Nobody can vote for the first **5 minutes**; after a vote, everyone who took part waits **3 minutes**.
- **No time limit** on the game.

### How it ends
- **Seekers win** by **voting out the killer**.
- **The killer wins** by **eliminating every seeker**.

### Tech (for one slide, keep it light)
- **Frontend:** React + TypeScript, Leaflet maps with Mapbox dark tiles, installable PWA,
  background map that floats with the phone's **gyroscope**.
- **Backend:** Node.js + Express, real-time updates over **WebSockets** (every second).
- **Sonar:** Web Audio API — FFT of the microphone, signal-to-noise per player tone, hysteresis so
  it doesn't flicker.
- **Map data:** Mapbox to keep tasks out of water and buildings.
- **Fair play:** the server decides everything (roles, positions, kills, votes); phones only ever
  receive what their player is allowed to see.
- Hosted on our own server: **szponteam.pl**.

---

## Slide plan

1. **Title** — "Out of Signal" + the antenna icon + "SzponTeam". Tagline: *Find the killer before
   the signal is lost.*
2. **🔒 The hook** — "One of your friends is a killer." Click → "You don't know who." Click →
   "And they can see exactly where you are."
3. **What it is** — real-world hide-and-seek on your phone, 2–8 players, played in a real park.
4. **Setup** — host where you stand, pick the play area (150 / 300 / 500 m), only nearby players can
   join, roles shown for 5 seconds.
5. **🔒 Who sees what** — two columns, *Seeker* vs *Killer*. Show the seeker column first
   (own position, ping every 60 s). Reveal the killer column on click (everyone live, sees data carriers).
6. **Tasks** — towers and download points diagram: point → carry → tower, 20 s download.
7. **🔒 Clues** — "What does a powered tower tell you?" → reveal "NAME is not the killer."
   Next click: "One tower per seeker… power them all and only one name is left."
8. **Touching phones** — the sonar: inaudible 17.8–19.9 kHz tones, ~2 m range. Three actions as
   three icons: Share · Vote · (🔒 Kill — reveal last).
9. **The vote** — more than half of all living players, physically together. Voted-out role revealed.
10. **Rules that keep it fair** — 3 min no-kill start, 5 min no-vote start, border is not a wall
    (30 m / 10 s), same buttons for everyone.
11. **How to win** — Seekers: vote out the killer. Killer: eliminate everyone.
12. **Under the hood** — tech slide (keep to 5 bullets + small stack logos/labels).
13. **Demo / Try it** — "Install from szponteam.pl → Add to Home Screen". Big QR code placeholder.
14. **Thanks** — SzponTeam, questions.

### Speaker notes to include
- Slide 2: pause between reveals.
- Slide 5: mention that the killer's live view is balanced by the 3-minute no-kill start.
- Slide 8: explain why sound — GPS is 5–15 m off, sound tells "right next to me" reliably.
- Slide 12: the server never sends roles to phones that shouldn't know them.
