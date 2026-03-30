# ♠ Spades Online — Product Requirements Document

| Field | Value |
|---|---|
| **Version** | 1.2 — Rules Clarifications |
| **Date** | March 2026 |
| **Status** | For Review |
| **Product** | Spades Online (Mobile & Web) |

---

## 1. Product Overview

Spades Online is a digital implementation of the classic card game Spades, designed for casual social play. The product targets existing Spades enthusiasts seeking an authentic online experience, as well as newcomers to the game. It will be available on web and mobile platforms. This document covers the v1.0 MVP scope; planned post-launch features are listed in [Section 9](#9-post-launch-roadmap).

### 1.1 Vision

> **"The most polished and social digital Spades experience available — easy to pick up, fun to share."**

### 1.2 Goals & Success Metrics

| Goal | Description | Target Metric |
|---|---|---|
| Engagement | Players return regularly and complete sessions | D7 retention ≥ 35% |
| Quality | Smooth, bug-free experience | Crash rate < 0.5%; avg session rating ≥ 4.2 / 5 |
| Social | Friends system drives retention | ≥ 40% of retained players have at least 1 friend |

---

## 2. Play Modes

v1.0 ships with casual (unranked) table-based play only. Ranked matchmaking is planned for v1.2 (see [Section 9](#9-post-launch-roadmap)).

### 2.1 Casual (Unranked) — Table-Based Play

Casual mode uses a lobby/table metaphor where players sit down and play without any impact on a rated standing. This mode prioritizes accessibility, social flexibility, and low-friction entry.

#### 2.1.1 Table Creation & Configuration

- Any authenticated player may create a table at any time.
- On creation, the host configures the following options:
  - **Table name** (optional, displayed in the public lobby browser)
  - **Visibility:** controls who can see, arrive at, and spectate the table
    - *Public* — listed in the lobby browser for all players
    - *Friends-Only* — visible to the host's friends via the friends list; not listed in the lobby browser
    - *Private* — not listed anywhere; only reachable via a join link, spectator link, or direct in-app invite
  - **Join policy:** controls who may sit down among those who can already see the table. Cannot be less restrictive than visibility; available options are filtered accordingly:
    - *Open* — anyone who can see the table may sit (available for Public tables only)
    - *Friends-Only* — only the host's friends may sit directly (available for Public and Friends-Only tables)
    - *Invite-Only* — players may only sit via a join link or direct in-app invite (available for all visibility levels). Private tables are always Invite-Only; the join policy control is hidden when Private is selected.
  - **Spectating:** allow or disallow spectators (deferred to v1.1 — this setting is present in v1.0 but non-functional and labelled "Coming Soon")
- The host may transfer host privileges to any seated player at any time.
- The host may kick a player from the table.

#### 2.1.2 Public Lobby Browser

- A browsable list of all Public tables is accessible from the main menu.
- Each entry displays: table name, host name, current seat occupancy (e.g., 3/4), ruleset (Standard), and join policy (Open, Friends-Only, or Invite-Only).
- Filtering options: by seats available, by name search.
- Players may arrive at any Public table to spectate (subject to the host's spectating setting) or sit, subject to join policy. Open tables show a Join button for all players. Friends-Only tables show a Join button only for friends of the host. Invite-Only tables show no Join button — a join link or direct invite is required to sit.

#### 2.1.3 Invitations

- The host may invite players via:
  - **Friends list** — sends an in-app notification to the invited player; grants visibility access and seating rights, bypassing join policy
  - **Shareable join link** — copies a join URL to the clipboard; grants visibility access and seating rights, bypassing join policy
  - **Shareable spectator link** — copies a spectator-only URL to the clipboard; grants visibility access and spectating only, bypassing visibility restrictions but not seating rights (deferred to v1.1 — labelled "Coming Soon" in v1.0)
  - **Username search** — search by username and invite directly; grants visibility access and seating rights, bypassing join policy
- Invited players receive a notification with a one-click Join button.
- Players may decline an invitation; the host is notified.
- Any player who can see a table — whether via the lobby browser, friends list, join link, or spectator link — may spectate it, subject to the host's spectating setting.

#### 2.1.4 Seating & Teams

- Tables seat exactly 4 players in fixed partnership pairs: North/South vs. East/West.
- The host may assign seats manually or allow players to choose.
- A game does not start until all 4 human seats are filled.

---

## 3. Social Features

### 3.1 Friends List

- Players may send, accept, or decline friend requests by searching for other players by username.
- The friends list displays each friend's online/offline/in-game status. If a friend is at a table:
  - If the player has permission to see the table (i.e. it is Public, or Friends-Only and they are a friend of the host), the table name is shown alongside their status.
  - If the player does not have permission to see the table, their status shows as "Playing at a private table" with no further detail.
  - If a friend is in a lobby but not yet in a game, their status shows as "In lobby".
- Players may go to a friend's table directly from the friends list. Arriving at a table puts the player in an observer state; sitting down is a separate step governed by join policy. Friends of the host may sit directly at Friends-Only and Open tables; Invite-Only tables require a join link or direct invite to sit.
- Players may invite friends to a casual table from the friends list.
- Players may remove or block a friend at any time. Blocked players cannot send friend requests or game invitations.
- Friend request notifications are delivered in-app and (if enabled) via push notification.

### 3.2 Player Profiles

Each player has a public profile displaying: username, avatar, career win/loss record, recent game history (last 20 games), and selected cosmetics.

### 3.3 In-Game Chat

- A chat panel is available during casual games (host may disable for their table).
- All chat is subject to automated profanity filtering. Players may report abuse; moderation policy and mute mechanics are to be decided (see OQ-6).

---

## 4. Settings & Customization

### 4.1 Visual Customization

Players may personalize their experience through the following visual settings, accessible from the main menu or the in-game settings panel. Premium cosmetics are deferred to v1.3.

| Setting | v1.0 Options |
|---|---|
| Table Felt / Background | 4 classic felt colors (green, navy, burgundy, charcoal) |
| Card Backs | 3 classic designs (standard red, standard blue, minimal) |
| Hand Display Style | Spread (fan), Hand Diagram |
| Avatar / Profile Icon | 8 default icons |

### 4.2 Audio Settings

- Master volume, music volume, and sound effects volume controls (independent sliders, 0–100%).
- Toggle options: card deal sounds, bid announcement sounds, trick win sounds, background music, victory/defeat fanfare.
- Background music selection: choose from a small library of ambient tracks or off.
- All audio defaults to ON at 70% volume; mute all is a single toggle.

### 4.3 Gameplay Settings

- Hands are always sorted by suit and rank. This is not configurable.
- **Confirm plays:** toggle a confirmation prompt before playing a card (off by default).
- **Animation speed:** slow / normal / fast for card animations.
- **Previous trick:** players may tap/click to view the previous trick at any time until they have played a card to the current trick, at which point it is no longer accessible.
- **Notifications:** configure push notification preferences for friend activity and game invitations.

---

## 5. Ruleset

v1.0 ships with a single standard ruleset. Rule customization is deferred to v1.3 (see [Section 9](#9-post-launch-roadmap)).

### 5.1 Standard Ruleset

| Rule | Detail |
|---|---|
| **Target Score** | 250 points. First team to reach 250 wins. If both teams reach 250 in the same round, the team with the higher score wins. If both teams are tied on exactly the same score, an additional hand is played; this repeats until the tie is broken. |
| **Loss by Negative Score** | A team whose score reaches -250 or lower loses immediately, unless both teams are at -250 or lower simultaneously, in which case the team with the higher score wins. If both teams are tied on exactly the same score, an additional hand is played; this repeats until the tie is broken. |
| **Dealer** | North deals the first hand. The dealer button rotates clockwise each hand. |
| **Bags** | Standard bag rules apply. Overtricks (bags) count +1 each. Every 10 bags accumulated deducts 100 points from that team's score. Tricks taken by a nil bidder count toward their partner's bid and are bags if they cause the partner to exceed it. If both players on a team bid Nil or Blind Nil, every trick either player takes is a bag and breaks that individual's Nil. |
| **First Trick** | A Spade may not be played on the first trick of a hand, even if a player has no cards of the led suit. |
| **Spades Breaking** | Spades are broken by the first Spade played (after the first trick). Once broken, Spades may be led. |
| **Nil** | +50 if successful, -50 if failed. Available to any player at any time. |
| **Blind Nil Eligibility** | A player may bid Blind Nil only if their team is at least 100 points behind the opposing team. |
| **Blind Nil Score** | +100 if successful, -100 if failed. |
| **Blind Nil Limit** | Only one player per team may bid Blind Nil in a given hand. |
| **Blind Nil Card Exchange** | The card exchange occurs after all four players have bid but before the opening lead. The Blind Nil player passes 2 cards face-down to their partner; the partner then passes 2 cards back. |
| **Team Bid of Zero** | A combined team bid of 0 is legal and is not treated as a Nil bid. Every trick the team takes is a bag. |

### 5.2 Bidding Rules (Partnership Bidding)

The bidding sequence follows a partnership model designed to allow informed team bids. Bidding begins with the player to the dealer's left and proceeds clockwise. Once all bids are placed, the player to the dealer's left makes the opening lead.

- **First bidder** on each team bids individually (a number 0–13, or Nil, or Blind Nil if eligible).
- **Second bidder** on the team sees their partner's bid before bidding. They bid the team's combined total, or Nil/Blind Nil for themselves.
- The second bidder's combined bid overrides whatever the first bidder said, except in the case of Nil or Blind Nil — those individual bids stand regardless of the partner's team bid.
- The team's combined bid may be lower than the first bidder's individual bid (the second bidder has more information and may wish to set a lower team target to avoid bags).

> **Example:** North bids 4. South (second bidder) sees the 4 and bids a team total of 7. The team target is 7 (South has effectively bid 3 for themselves). If North had instead bid Nil, North's Nil bid stands and South bids only their own hand.

---

## 6. Technical Requirements

### 6.1 Platform Support

- **Web:** Modern browsers (Chrome 100+, Firefox 100+, Safari 15+, Edge 100+). Responsive design for desktop and tablet viewports.
- **Mobile:** iOS 15+ and Android 10+. Native apps via React Native or Flutter.
- **Offline:** Not supported. An active internet connection is required at all times.

### 6.2 Performance Targets

| Metric | Target |
|---|---|
| Turn action latency (player plays a card → all clients updated) | < 200ms (p95) |
| App cold start time | < 3 seconds on mid-range devices |
| Concurrent game sessions supported (initial launch) | 10,000+ |
| Uptime SLA | 99.5% monthly |

### 6.3 Security & Fairness

- All game state is validated server-side. Clients are thin; no card information about other players is ever sent to a client before it is played.
- **Anti-cheat:** server enforces legal move validation; clients cannot play out-of-turn or play cards not in their hand.
- **Account security:** email/password with required email verification; optional 2FA via authenticator app.
- Rate limiting on all authentication and social endpoints to prevent abuse.

---

## 7. Open Questions

| # | Question / Decision Needed |
|---|---|
| OQ-1 | Premium pricing model: monthly subscription vs. one-time cosmetic packs vs. both? Initial recommendation is monthly subscription ($4.99/mo or $39.99/yr) with optional one-time cosmetic bundles. Decision needed before v1.3 scoping. |
| OQ-2 | Should the partnership bidding system be the only available mode, or should individual bidding also be supported as a configurable option? Decision needed before v1.3 (rule customization). |
| OQ-3 | Should ranked games use a fixed 250-point target or be configurable? Decision needed before v1.2 (ranked play). |
| OQ-4 | Should Solo Queue and Duo Queue share one MMR or have separate ratings? Decision needed before v1.2 (ranked play). |
| OQ-5 | Should spectating in casual games support a chat-only mode for spectators, or strictly observe-only? Decision needed before v1.1 (spectating). |
| OQ-6 | Chat moderation: what constitutes persistent abuse, who reviews reports, and how are mutes applied and lifted? Automated profanity filtering ships in v1.0; human moderation policy and tooling to be decided before launch. |

---

## 8. Glossary

| Term | Definition |
|---|---|
| **Bags / Overtricks** | Tricks won in excess of a team's bid. Accumulate as a 1-point bonus each; every 10 bags deducts 100 points. |
| **Bid** | The number of tricks a player or team commits to winning in a hand. |
| **Blind Nil** | A bid of zero tricks made before the player has seen their hand, with a card exchange with their partner before play begins. |
| **Breaking Spades** | The act of playing a Spade (the trump suit) for the first time after the first trick, permitting Spades to be led thereafter. |
| **Hand Diagram** | A hand display style in which cards are presented as a compact text list grouped by suit, each suit shown on its own line with its symbol followed by the card ranks in descending order (e.g., ♠J32, ♥A32, ♦K32, ♣AQ32). Suits with no cards are omitted. |
| **MMR** | Matchmaking Rating — the numerical skill score used to match and rank players (planned for v1.2). |
| **Nil** | A bid of zero tricks made after the player has seen their hand. |
| **Partnership Bidding** | A bidding structure in which the second bidder sets the team's combined target, overriding the first bidder's individual number. |
| **Ranked Tiers** | Named divisions (Bronze, Silver, Gold, Platinum, Diamond) based on MMR ranges (planned for v1.2). |
| **Trick** | One round of play in which each player plays one card; the highest Spade (or highest card of the led suit if no Spade) wins. |

---

## 9. Post-Launch Roadmap

The following features are out of scope for v1.0 and are planned for subsequent releases in priority order. Items within each phase are listed in descending priority.

### v1.1 — Bot & Spectating

#### Standard Bot + Disconnect Fill

A rule-based AI opponent that plays legal, competent Spades. Serves two purposes:

- **Casual play opponent** — players may sit down against bots intentionally.
- **Disconnect fill** — when a player disconnects and does not reconnect by the start of the next hand, a bot takes their seat for that hand. The player may rejoin at the start of any subsequent hand.

Table host may configure: bot fill on disconnect only, always allow bots, or no bots.

#### Spectating (Casual Games)

Spectators may observe any public table the host permits. They occupy a separate observer rail and cannot influence the game. In-game chat access for spectators to be decided (see OQ-5).

---

### v1.2 — Ranked Play

#### Solo Ranked Queue

Individual players are matched automatically by the system and assigned partners. Performance affects MMR.

- Tiers: Bronze, Silver, Gold, Platinum, Diamond.
- Ranked games always use the Standard Ruleset.

#### Duo Ranked Queue

Two friends may queue together as a pre-formed partnership. Matched against another duo or two solo players of comparable combined MMR. A small MMR adjustment is applied to account for coordination advantage. Depends on Solo Queue infrastructure.

#### MMR System

- Elo-based rating adapted for 4-player team games.
- Starting MMR: 1000.
- Provisional period: first 10 ranked games.
- Win/loss delta based on expected win probability; small margin modifier (±20%) for dominant wins or close losses.
- Leaver penalty for disconnects; repeat leavers receive temporary matchmaking bans.

---

### v1.3 — Premium & Customization

#### Premium Cosmetics & Billing

Subscription (monthly/annual) or one-time bundle unlocks:

- Additional card backs (15+ total)
- Table styles (10+ total)
- Animated cosmetics
- Alternate card faces
- Avatar frames

Pricing model to be decided (see OQ-1). No gameplay advantages — premium is strictly cosmetic.

#### Ruleset Customization

Table hosts in casual mode may configure: target score, nil/blind nil values and eligibility, bags rule, bidding style (partnership vs. individual), minimum bid, spades breaking, and joker rules.

#### Profile Privacy, Badge & Extended History

- Players may set profiles to private (stats hidden from non-friends).
- Premium subscribers receive a profile badge and access to full career game history beyond the standard 20-game window.

#### Subscription Gifting

Players may purchase and gift a Premium subscription to a friend.

---

### v2.0 — Game Variants & Platform Expansion

#### Game Variants

- **Cutthroat Spades** — 4-player, no partnerships; each player plays for themselves.
- **Suicide** — one player from each team must bid Nil.
- **Whiz** — each player must bid Nil or the number of Spades in their hand.
- **Mirrors** — each player must bid the number of Spades in their hand; 0 Spades = Nil.

Variants may introduce separate casual lobbies.

#### Further Deferred Items

- Strong bot (advanced AI opponent, premium feature)
- Tournaments and organized competitive events
- Replay viewer for completed games
- In-game voice chat
- Team/clan system
- Localization beyond English
- Spectator mode for ranked games
- Third-party social login (Google, Apple ID)

---

*End of Document — Spades Online PRD v1.2*
