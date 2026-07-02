# LingLang Website & Dashboard Design Spec

> **Design direction:** Technical & Premium, dark-themed, "Cognitive Sanctuary" aesthetic.
> Two separate pages: Landing page (marketing/waitlist) and Dashboard (user app).
> No LiveKit in frontend yet — dashboard shows progress from API only.

---

## 1. Brand & Design System

**North Star:** The Cognitive Sanctuary — a dark, professional lab environment that makes the AI/ML sophistication tangible.

**Color tokens:**

| Token | Hex | Purpose |
|---|---|---|
| `surface` | `#0b1326` | Infinite dark background |
| `surface-low` | `#131b2e` | Large section containers |
| `surface-mid` | `#1a2035` | Cards, sidebar |
| `surface-high` | `#222a3d` | Active/hover cards |
| `surface-top` | `#2d3449` | Highest elevation |
| `surface-well` | `#060e20` | Recessed inputs |
| `primary` | `#b4c5ff` | Primary accent, links, headings |
| `secondary` | `#4edea3` | Success, progress, SRS metrics |
| `tertiary` | `#7bd0ff` | Interactive hints |
| `on-surface` | `#dae2fd` | Primary body text |
| `on-surface-variant` | `#c6c6cd` | Muted/secondary text |
| `outline-variant` | `#45464d` | Ghost borders (20% opacity when needed) |
| `error` | `#ffb4ab` | Errors |

**Rules:**
- No 1px borders. Hierarchy through background color shifts only.
- Glassmorphism for overlays: `backdrop-filter: blur(20px)` with `surface-container` at 40% opacity.
- Primary CTA uses gradient: `linear-gradient(135deg, #b4c5ff, #4278ff)`.
- Progress/SRS uses `secondary` (#4edea3) with subtle glow on leading edge.
- Typography: **Manrope** for display/headlines, **Inter** for body/labels, **JetBrains Mono** for data/code.
- Border-radius: `0.75rem` (12px) for cards, `0.5rem` (8px) for buttons, `2rem` for pills/chips.
- 3D elements: Three.js (via CDN) for animated hero visual on landing page.

---

## 2. Landing Page (`/`)

**File:** `agents/src/dashboard/public/index.html`
**Served at:** `https://app.senilelines.com/` (nginx → Express static)

### 2.1 Hero Section
- Large Manrope display text: tagline TBD (e.g., "The language tutor that learns from your voice")
- 3D animated visual: a slowly rotating, translucent mesh/sphere with glowing node connections (representing the semantic knowledge graph). Implemented with Three.js loaded from CDN.
- CTA button: "Get Early Access" (opens email input inline, no navigation)
- Subtle subtitle referencing the tech (FSRS, semantic ripple, voice-first)

### 2.2 "How It Works" Section
- 3 steps, each with an icon and short description:
  1. **You speak** — Voice-first conversation with personality tutors (Маша, Marta, etc.)
  2. **It listens** — The Processor analyzes every word you say in real-time (morphology, grammar, performance)
  3. **It adapts** — FSRS + Semantic Ripple means the system learns what you know and what you're struggling with, and adjusts what it teaches next

### 2.3 Feature Deep-Dives (3 sections)
- **Spaced Repetition That Listens** — No tapping "Hard/Good/Easy." The system grades from your voice: pronunciation confidence, response latency, escalation level. Shows a visual of the FSRS state machine.
- **Semantic Ripple** — Learning "яблоко" micro-boosts semantically similar words via pgvector. Shows a small interactive node graph visualization.
- **Goal-Seeking Agents** — The supervisor picks remediation/vocab/grammar goals and injects them mid-conversation. No passive flashcard review.

### 2.4 Language Showcase
- Horizontal card row showing the 6 languages with their personality descriptions:
  - 🇷🇺 Russian — Маша (Moscow intellectual)
  - 🇪🇸 Spanish — Marta (Madrid journalist)
  - 🇫🇷 French — (personality TBD)
  - 🇵🇹 Portuguese — (personality TBD)
  - 🇬🇧 English — Power Vocab
  - 🇸🇦 Arabic — (personality TBD)
- Each card: flag, language name, tutor personality name, native greeting

### 2.5 Footer
- "Built with LiveKit, PostgreSQL, pgvector, FSRS"
- GitHub link
- "Get Early Access" CTA repeated
- Copyright

---

## 3. Dashboard (`/dashboard`)

**File:** `agents/src/dashboard/public/dashboard.html`
**Served at:** `https://app.senilelines.com/dashboard`

### 3.1 Layout
- Left sidebar (220px): Logo, Language Switcher, Nav links (Progress, Vocabulary, Goals)
- Top bar: User identity (currently just username), Service health indicator
- Main content area: changes based on nav selection

### 3.2 Language Switcher
- Pill-style selector showing the 6 languages with flags
- Changing language triggers `/api/stats` refresh filtered by that language
- Defaults to user's `targetLanguage`

### 3.3 Progress View (Default)
- **Today's Summary card:** Reviews due count, words learned total, current streak (derived from `review_logs`)
- **FSRS State Distribution:** Horizontal stacked bar showing New/Learning/Review/Relearning percentages
- **Stability Over Time:** Simple line chart (last 7 days of review activity, using `/api/activity`)
- **Active Goal card:** Current goal type + target word, if any

### 3.4 Vocabulary View
- Searchable/filterable table of `user_vocabulary` items
- Columns: Word, Translation, State (color-coded badge), Stability, Due date
- Filter by state: New / Learning / Review / Relearning
- Click a word to see semantic neighbors (hardcoded query for now)

### 3.5 Goals View
- List of active/completed goals from `activeGoals`
- Simple timeline of goal transitions

### 3.6 Connect Section
- Instructions for starting a voice session via CLI: `pnpm dev:tutor-ed`
- Service health status (reuses `/api/services` endpoint)
- GPU memory usage bar

---

## 4. Technical Architecture

### 4.1 Server Changes (`agents/src/dashboard/server.ts`)
- Add `GET /` route that serves `index.html` (landing page) — Express static may not handle SPA routing, so add explicit route
- Add `GET /dashboard` route that serves `dashboard.html`
- Existing `/api/*` routes remain unchanged
- Add `GET /api/vocabulary/:language` endpoint that returns lexemes + progress for a specific language (dashboard needs this)

### 4.2 Frontend Tech
- Pure HTML + CSS + vanilla JavaScript
- Three.js loaded from CDN for landing page 3D hero only
- CSS custom properties for all design tokens
- No build step, no bundler
- Fetch API for all data calls
- Server-sent events for live log stream (already exists)

### 4.3 File Structure

```
agents/src/dashboard/public/
  index.html          ← Landing page (self-contained)
  dashboard.html       ← Dashboard app (self-contained)
  css/
    design-tokens.css ← Shared design tokens
    landing.css       ← Landing page styles
    dashboard.css     ← Dashboard styles
  js/
    landing.js        ← Landing page logic (3D, email capture, scroll animations)
    dashboard.js      ← Dashboard data fetching, rendering, interactions
```

### 4.4 Responsive
- Landing page: desktop-first with mobile breakpoints at 768px and 480px
- Dashboard: desktop-only for MVP (min-width 1024px), mobile is out of scope

---

## 5. Out of Scope

- LiveKit room connection in browser (future phase)
- User authentication (currently users are identified by LiveKit participant identity)
- Text-mode chat interface in dashboard (future)
- Mobile-responsive dashboard
- Payment/billing pages
- Multiple language learning simultaneously