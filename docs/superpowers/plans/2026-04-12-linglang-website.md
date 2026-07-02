# LingLang Website Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a premium dark-themed landing page and minimal viable dashboard for LingLang, served from the existing Express server.

**Architecture:** Two self-contained HTML pages with shared CSS design tokens. Landing page (`/`) uses Three.js CDN for a 3D hero visual and scroll animations. Dashboard (`/dashboard`) fetches from existing `/api/*` endpoints. No build step, no bundler, no React.

**Tech Stack:** HTML5, CSS custom properties, vanilla JavaScript, Three.js (CDN only), Express static serving

---

## File Structure

```
agents/src/dashboard/public/
  index.html              ← Landing page (self-contained)
  dashboard.html           ← Dashboard app (self-contained)
  css/
    design-tokens.css     ← Shared design system tokens
    landing.css           ← Landing page styles
    dashboard.css         ← Dashboard styles
  js/
    landing.js            ← Landing: 3D hero, scroll animations, email capture
    dashboard.js          ← Dashboard: data fetching, rendering, interactions
```

Server modifications:
```
agents/src/dashboard/server.ts   ← Add new API routes and page serving
```

---

### Task 1: CSS Design Tokens

**Files:**
- Create: `agents/src/dashboard/public/css/design-tokens.css`

- [ ] **Step 1: Create the design tokens CSS file**

```css
/* LingLang Design System — "Cognitive Sanctuary" */
/* Shared tokens for landing page and dashboard */

:root {
  /* Surface hierarchy — no borders, only tonal shifts */
  --surface:          #0b1326;
  --surface-low:      #131b2e;
  --surface-mid:      #1a2035;
  --surface-high:     #222a3d;
  --surface-top:      #2d3449;
  --surface-well:     #060e20;

  /* Accent palette */
  --primary:          #b4c5ff;
  --primary-container:#001442;
  --primary-gradient:  linear-gradient(135deg, #b4c5ff 0%, #4278ff 100%);
  --secondary:        #4edea3;
  --secondary-dim:    #00a572;
  --tertiary:         #7bd0ff;
  --tertiary-container:#001a27;
  --error:            #ffb4ab;
  --error-container:  #93000a;

  /* Text */
  --on-surface:       #dae2fd;
  --on-surface-variant:#c6c6cd;
  --on-primary:       #002a78;
  --on-surface-muted: #909097;

  /* Structural */
  --outline-variant:  #45464d;

  /* Typography */
  --font-display:     'Manrope', system-ui, -apple-system, sans-serif;
  --font-body:        'Inter', system-ui, -apple-system, sans-serif;
  --font-mono:        'JetBrains Mono', 'Fira Code', monospace;

  /* Sizes */
  --radius-sm:        0.5rem;   /* 8px — buttons */
  --radius-md:        0.75rem;  /* 12px — cards */
  --radius-lg:        1rem;     /* 16px — large cards */
  --radius-xl:        1.5rem;   /* 24px — pills */
  --radius-2xl:       2rem;     /* 32px — feature cards */

  /* Spacing */
  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-5: 1.25rem;
  --space-6: 1.5rem;
  --space-8: 2rem;
  --space-10: 2.5rem;
  --space-12: 3rem;
  --space-16: 4rem;
  --space-20: 5rem;
  --space-24: 6rem;

  /* Shadows — tinted, never pure black */
  --shadow-float:     0 20px 60px -15px rgba(0, 20, 66, 0.35);
  --shadow-subtle:    0 4px 20px -4px rgba(0, 20, 66, 0.2);

  /* Glassmorphism */
  --glass-bg:         rgba(23, 31, 51, 0.4);
  --glass-blur:       20px;

  /* Transitions */
  --transition-fast:   150ms ease;
  --transition-base:  250ms ease;
  --transition-slow:  400ms ease;
}

/* Google Fonts import — loaded once, used by both pages */
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');

/* Reset */
*, *::before, *::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family: var(--font-body);
  background: var(--surface);
  color: var(--on-surface);
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

/* Shared utility classes */
.surface-card {
  background: var(--surface-low);
  border-radius: var(--radius-md);
  padding: var(--space-6);
}

.surface-card-elevated {
  background: var(--surface-high);
  border-radius: var(--radius-md);
  padding: var(--space-6);
}

.text-primary { color: var(--primary); }
.text-secondary { color: var(--secondary); }
.text-tertiary { color: var(--tertiary); }
.text-muted { color: var(--on-surface-muted); }

.font-display { font-family: var(--font-display); }
.font-mono { font-family: var(--font-mono); }

/* Button styles */
.btn-primary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-6);
  background: var(--primary-gradient);
  color: var(--on-primary);
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 0.95rem;
  border-radius: var(--radius-sm);
  border: none;
  cursor: pointer;
  transition: all var(--transition-base);
  text-decoration: none;
}

.btn-primary:hover {
  transform: translateY(-1px);
  box-shadow: var(--shadow-float);
}

.btn-secondary {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-6);
  background: var(--surface-high);
  color: var(--on-surface);
  font-family: var(--font-display);
  font-weight: 600;
  font-size: 0.95rem;
  border-radius: var(--radius-sm);
  border: none;
  cursor: pointer;
  transition: all var(--transition-base);
  text-decoration: none;
}

.btn-secondary:hover {
  background: var(--surface-top);
  color: var(--primary);
}

/* Progress bar */
.progress-track {
  width: 100%;
  height: 0.5rem;
  background: var(--surface-well);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: var(--secondary);
  border-radius: var(--radius-sm);
  transition: width var(--transition-slow);
  box-shadow: 0 0 8px rgba(78, 222, 163, 0.4);
}

/* State badges */
.badge {
  display: inline-flex;
  align-items: center;
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-xl);
  font-size: 0.75rem;
  font-weight: 500;
  font-family: var(--font-body);
  letter-spacing: 0.02em;
}

.badge-new { background: rgba(123, 208, 255, 0.15); color: var(--tertiary); }
.badge-learning { background: rgba(180, 197, 255, 0.15); color: var(--primary); }
.badge-review { background: rgba(78, 222, 163, 0.15); color: var(--secondary); }
.badge-relearning { background: rgba(255, 180, 171, 0.15); color: var(--error); }
```

- [ ] **Step 2: Verify the file was created**

Run: `ls -la agents/src/dashboard/public/css/design-tokens.css`
Expected: File exists, ~3KB

- [ ] **Step 3: Commit**

```bash
cd /home/will/Desktop/LingLang && git add agents/src/dashboard/public/css/design-tokens.css && git commit -m "feat: add shared CSS design tokens for LingLang website"
```

---

### Task 2: Landing Page Structure & Hero Section

**Files:**
- Create: `agents/src/dashboard/public/index.html`
- Create: `agents/src/dashboard/public/css/landing.css`
- Create: `agents/src/dashboard/public/js/landing.js`

- [ ] **Step 1: Create the landing page HTML**

Create `agents/src/dashboard/public/index.html` with the complete page structure. This is a large file — the HTML contains: hero section with 3D canvas container, "How It Works" section, three feature deep-dives (FSRS, Semantic Ripple, Goal-Seeking Agents), language showcase section, and footer. The Three.js canvas is a full-viewport background behind the hero text. The page links to `css/design-tokens.css`, `css/landing.css`, and loads Three.js from CDN along with `js/landing.js`.

Key HTML structure:
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LingLang — The Language Tutor That Learns From Your Voice</title>
  <meta name="description" content="Voice-first language learning with invisible spaced repetition, semantic knowledge graphs, and goal-seeking AI agents. Learn Russian, Spanish, French, Portuguese, Arabic, or English.">
  <link rel="stylesheet" href="css/design-tokens.css">
  <link rel="stylesheet" href="css/landing.css">
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🗣</text></svg>">
</head>
<body>
  <!-- Navigation -->
  <nav class="landing-nav">
    <div class="nav-inner">
      <a href="/" class="nav-logo">LingLang</a>
      <div class="nav-links">
        <a href="#how-it-works">How It Works</a>
        <a href="#features">Features</a>
        <a href="#languages">Languages</a>
        <a href="/dashboard" class="btn-secondary nav-dashboard-btn">Dashboard</a>
      </div>
    </div>
  </nav>

  <!-- Hero Section -->
  <section class="hero" id="hero">
    <canvas id="hero-canvas"></canvas>
    <div class="hero-overlay"></div>
    <div class="hero-content">
      <div class="hero-badge">Voice-First AI Tutor</div>
      <h1 class="hero-title font-display">
        The language tutor<br>that <span class="text-secondary">learns</span> from your voice
      </h1>
      <p class="hero-subtitle">
        Invisible spaced repetition. Semantic knowledge graphs. Goal-seeking agents.<br>
        No flashcards. No tapping. Just conversation.
      </p>
      <div class="hero-cta-group">
        <button class="btn-primary hero-cta" id="early-access-btn">Get Early Access</button>
        <div class="hero-cta-note">6 languages · 100% local option · Privacy-first</div>
      </div>
      <div class="email-form" id="email-form" style="display:none;">
        <input type="email" id="email-input" placeholder="your@email.com" class="email-input">
        <button class="btn-primary email-submit" id="email-submit">Join Waitlist</button>
        <div class="email-status" id="email-status"></div>
      </div>
    </div>
  </section>

  <!-- How It Works -->
  <section class="how-it-works" id="how-it-works">
    <div class="section-inner">
      <h2 class="section-title font-display">How It Works</h2>
      <div class="steps-grid">
        <div class="step-card surface-card">
          <div class="step-number font-mono">01</div>
          <div class="step-icon">🗣️</div>
          <h3 class="step-title font-display">You speak</h3>
          <p class="step-desc">Converse naturally with a personality tutor — a Moscow intellectual for Russian, a Madrid journalist for Spanish. Each language has its own character, its own voice.</p>
        </div>
        <div class="step-card surface-card">
          <div class="step-number font-mono">02</div>
          <div class="step-icon">🔍</div>
          <h3 class="step-title font-display">It listens</h3>
          <p class="step-desc">Every word you say is analyzed in real-time — morphology, grammar, pronunciation confidence, response latency. No buttons. No self-assessment. The system grades you from your voice.</p>
        </div>
        <div class="step-card surface-card">
          <div class="step-number font-mono">03</div>
          <div class="step-icon">🧠</div>
          <h3 class="step-title font-display">It adapts</h3>
          <p class="step-desc">The Supervisor picks your next goal — remediation for struggling words, new vocabulary introduction, or grammar practice. FSRS schedules reviews. Semantic ripple reinforces connected words.</p>
        </div>
      </div>
    </div>
  </section>

  <!-- Feature: FSRS -->
  <section class="feature-section" id="features">
    <div class="section-inner feature-grid">
      <div class="feature-visual">
        <div class="fsrs-diagram" id="fsrs-diagram">
          <!-- FSRS state machine visualization built with CSS -->
          <div class="fsrs-state fsrs-new" data-state="0">
            <span class="fsrs-state-label">New</span>
            <span class="fsrs-state-sub">Never seen</span>
          </div>
          <div class="fsrs-state fsrs-learning" data-state="1">
            <span class="fsrs-state-label">Learning</span>
            <span class="fsrs-state-sub">S < 3 days</span>
          </div>
          <div class="fsrs-state fsrs-review" data-state="2">
            <span class="fsrs-state-label">Review</span>
            <span class="fsrs-state-sub">S ≥ 3 days</span>
          </div>
          <div class="fsrs-state fsrs-relearning" data-state="3">
            <span class="fsrs-state-label">Relearning</span>
            <span class="fsrs-state-sub">Lapsed</span>
          </div>
          <svg class="fsrs-arrows" viewBox="0 0 400 100" aria-hidden="true">
            <line x1="80" y1="50" x2="120" y2="50" stroke="var(--primary)" stroke-width="2" marker-end="url(#arrow)"/>
            <line x1="200" y1="50" x2="280" y2="50" stroke="var(--primary)" stroke-width="2" marker-end="url(#arrow)"/>
            <line x1="320" y1="30" x2="200" y2="30" stroke="var(--error)" stroke-width="2" stroke-dasharray="4,4"/>
          </svg>
        </div>
      </div>
      <div class="feature-text">
        <div class="feature-tag font-mono">FSRS Engine</div>
        <h2 class="feature-title font-display">Spaced repetition that <span class="text-secondary">listens</span></h2>
        <p class="feature-desc">Traditional SRS makes you tap "Hard, Good, Easy." LingLang grades you from your voice — pronunciation confidence, response latency, escalation level. The FSRS algorithm maps these to stability and difficulty scores, scheduling reviews before you forget.</p>
        <div class="feature-stats">
          <div class="stat">
            <span class="stat-value font-mono text-secondary">4</span>
            <span class="stat-label text-muted">Grade levels</span>
          </div>
          <div class="stat">
            <span class="stat-value font-mono text-secondary">90%</span>
            <span class="stat-label text-muted">Target retention</span>
          </div>
          <div class="stat">
            <span class="stat-value font-mono text-secondary">0</span>
            <span class="stat-label text-muted">Button taps</span>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- Feature: Semantic Ripple -->
  <section class="feature-section feature-alt">
    <div class="section-inner feature-grid feature-grid-reverse">
      <div class="feature-visual">
        <div class="ripple-visual" id="ripple-visual">
          <canvas id="ripple-canvas" width="400" height="300"></canvas>
        </div>
      </div>
      <div class="feature-text">
        <div class="feature-tag font-mono">Semantic Ripple</div>
        <h2 class="feature-title font-display">Learning one word <span class="text-tertiary">boosts</span> the next</h2>
        <p class="feature-desc">Every word in LingLang has a 1024-dimensional embedding. When you master "яблоко" (apple), the system finds its 5 nearest semantic neighbors in pgvector — "груша" (pear), "фрукт" (fruit) — and applies a micro-boost to their stability. When you struggle, the ripple penalizes related words. Your knowledge graph heals itself.</p>
        <div class="feature-stats">
          <div class="stat">
            <span class="stat-value font-mono text-tertiary">1024</span>
            <span class="stat-label text-muted">Dimensions</span>
          </div>
          <div class="stat">
            <span class="stat-value font-mono text-tertiary">5</span>
            <span class="stat-label text-muted">Neighbors per word</span>
          </div>
          <div class="stat">
            <span class="stat-value font-mono text-tertiary">HNSW</span>
            <span class="stat-label text-muted">Index type</span>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- Feature: Goal-Seeking Agents -->
  <section class="feature-section">
    <div class="section-inner feature-grid">
      <div class="feature-visual">
        <div class="agent-visual">
          <div class="agent-flow">
            <div class="agent-node agent-user">
              <div class="agent-node-icon">👤</div>
              <div class="agent-node-label">You speak</div>
            </div>
            <div class="agent-arrow">→</div>
            <div class="agent-node agent-processor">
              <div class="agent-node-icon">⚡</div>
              <div class="agent-node-label">Processor</div>
              <div class="agent-node-sub">Analyzes every word</div>
            </div>
            <div class="agent-arrow">→</div>
            <div class="agent-node agent-supervisor">
              <div class="agent-node-icon">🎯</div>
              <div class="agent-node-label">Supervisor</div>
              <div class="agent-node-sub">Sets goals, adapts plan</div>
            </div>
            <div class="agent-arrow">→</div>
            <div class="agent-node agent-tutor">
              <div class="agent-node-icon">🗣️</div>
              <div class="agent-node-label">Tutor</div>
              <div class="agent-node-sub">Converses naturally</div>
            </div>
          </div>
        </div>
      </div>
      <div class="feature-text">
        <div class="feature-tag font-mono">Goal-Seeking Agents</div>
        <h2 class="feature-title font-display">A tutor that <span class="text-primary">plans</span> for you</h2>
        <p class="feature-desc">The Supervisor runs on a timer and signal accumulator. When you struggle with a word, it sets a remediation goal. When you've mastered your current unit, it introduces the next vocabulary. The plan updates in real-time, injected into the tutor's context mid-conversation. You never have to choose what to study next.</p>
        <div class="feature-stats">
          <div class="stat">
            <span class="stat-value font-mono text-primary">3</span>
            <span class="stat-label text-muted">Goal types</span>
          </div>
          <div class="stat">
            <span class="stat-value font-mono text-primary">Real-time</span>
            <span class="stat-label text-muted">Plan updates</span>
          </div>
          <div class="stat">
            <span class="stat-value font-mono text-primary">0</span>
            <span class="stat-label text-muted">Manual choices</span>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- Languages -->
  <section class="languages-section" id="languages">
    <div class="section-inner">
      <h2 class="section-title font-display">Six languages. Six personalities.</h2>
      <p class="section-subtitle text-muted">Each tutor is a character, not a chatbot. They have opinions, humor, and cultural depth.</p>
      <div class="language-grid">
        <div class="lang-card surface-card" data-lang="ru">
          <span class="lang-flag">🇷🇺</span>
          <h3 class="lang-name font-display">Russian</h3>
          <p class="lang-persona">Маша — Moscow intellectual</p>
          <p class="lang-greeting">Ну вот, русский. Привет!</p>
          <span class="lang-ratio font-mono">80/20 immersive</span>
        </div>
        <div class="lang-card surface-card" data-lang="es">
          <span class="lang-flag">🇪🇸</span>
          <h3 class="lang-name font-display">Spanish</h3>
          <p class="lang-persona">Marta — Madrid journalist</p>
          <p class="lang-greeting">¡Hola! ¿Qué tal?</p>
          <span class="lang-ratio font-mono">80/20 immersive</span>
        </div>
        <div class="lang-card surface-card" data-lang="fr">
          <span class="lang-flag">🇫🇷</span>
          <h3 class="lang-name font-display">French</h3>
          <p class="lang-persona">Professeur cultivé</p>
          <p class="lang-greeting">Bonjour — on commence?</p>
          <span class="lang-ratio font-mono">75/25 immersive</span>
        </div>
        <div class="lang-card surface-card" data-lang="pt">
          <span class="lang-flag">🇵🇹</span>
          <h3 class="lang-name font-display">Portuguese</h3>
          <p class="lang-persona">European Portuguese</p>
          <p class="lang-greeting">Olá — vamos lá!</p>
          <span class="lang-ratio font-mono">80/20 immersive</span>
        </div>
        <div class="lang-card surface-card" data-lang="ar">
          <span class="lang-flag">🇸🇦</span>
          <h3 class="lang-name font-display">Arabic</h3>
          <p class="lang-persona">Patient guide</p>
          <p class="lang-greeting">أهلاً! Ready to learn?</p>
          <span class="lang-ratio font-mono">70/30 assisted</span>
        </div>
        <div class="lang-card surface-card" data-lang="en">
          <span class="lang-flag">🇬🇧</span>
          <h3 class="lang-name font-display">English</h3>
          <p class="lang-persona">Power Vocab — advanced vocabulary</p>
          <p class="lang-greeting">All right. Say one sentence.</p>
          <span class="lang-ratio font-mono">100/0 immersive</span>
        </div>
      </div>
    </div>
  </section>

  <!-- CTA / Footer -->
  <section class="cta-section">
    <div class="section-inner">
      <h2 class="cta-title font-display">Ready to talk?</h2>
      <p class="cta-subtitle text-muted">The most advanced language tutor on the planet is waiting.</p>
      <button class="btn-primary cta-button" id="early-access-btn-footer">Get Early Access</button>
      <div class="email-form" id="email-form-footer" style="display:none;">
        <input type="email" id="email-input-footer" placeholder="your@email.com" class="email-input">
        <button class="btn-primary email-submit" id="email-submit-footer">Join Waitlist</button>
        <div class="email-status" id="email-status-footer"></div>
      </div>
    </div>
  </section>

  <footer class="landing-footer">
    <div class="section-inner">
      <div class="footer-tech">
        <span class="text-muted">Built with</span>
        <span class="footer-tech-item">LiveKit</span>
        <span class="footer-tech-item">PostgreSQL</span>
        <span class="footer-tech-item">pgvector</span>
        <span class="footer-tech-item">FSRS</span>
        <span class="footer-tech-item">Ollama</span>
      </div>
      <div class="footer-bottom">
        <span class="text-muted">© 2026 LingLang</span>
        <a href="/dashboard" class="text-muted">Dashboard</a>
      </div>
    </div>
  </footer>

  <!-- Three.js from CDN -->
  <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r170/three.min.js"></script>
  <script src="js/landing.js"></script>
</body>
</html>
```

- [ ] **Step 2: Commit the landing HTML**

```bash
cd /home/will/Desktop/LingLang && git add agents/src/dashboard/public/index.html && git commit -m "feat: add landing page HTML structure with hero, features, and languages"
```

---

### Task 3: Landing Page CSS

**Files:**
- Create: `agents/src/dashboard/public/css/landing.css`

- [ ] **Step 1: Create the landing page stylesheet**

Create `agents/src/dashboard/public/css/landing.css` with all styles for the landing page sections. Key sections to include:

1. **Nav bar** — fixed, glassmorphism background, logo left, links right
2. **Hero section** — full viewport height, canvas behind content, centered text with glass overlay
3. **How It Works** — 3-column card grid, numbered steps
4. **Feature sections** — alternating left/right layout, feature-tag, stats row
5. **FSRS diagram** — CSS grid of 4 state boxes with connecting SVG arrows
6. **Ripple visual** — canvas container for the node graph animation
7. **Agent flow** — horizontal flow of connected nodes
8. **Language grid** — 3x2 responsive grid of language cards
9. **CTA section** — simple centered CTA
10. **Footer** — tech stack pills, copyright
11. **Email form** — inline form for waitlist
12. **Animations** — scroll-triggered fade-ins, pulse on secondary accent

The CSS should be comprehensive (all classes from the HTML are styled). Use `var()` references to design tokens throughout. Mobile breakpoints at 768px and 480px should stack grids vertically.

- [ ] **Step 2: Commit the landing CSS**

```bash
cd /home/will/Desktop/LingLang && git add agents/src/dashboard/public/css/landing.css && git commit -m "feat: add landing page stylesheet with Cognitive Sanctuary theme"
```

---

### Task 4: Landing Page JavaScript (3D Hero + Interactions)

**Files:**
- Create: `agents/src/dashboard/public/js/landing.js`

- [ ] **Step 1: Create the landing page JavaScript**

Create `agents/src/dashboard/public/js/landing.js` with:

1. **Three.js hero scene** — Create a scene with:
   - A slowly rotating icosahedron (wireframe, `primary` color, slightly transparent)
   - Floating particles around it (small spheres, `secondary` color)
   - Lines connecting nearby particles (very faint, `tertiary` color)
   - Ambient light + point light
   - Camera at z=5, subtle mouse-follow parallax
   - Responsive resize handler
   - `requestAnimationFrame` loop with rotation

2. **Ripple canvas animation** — 2D canvas in the "Semantic Ripple" section:
   - Draw a central word node ("яблоко")
   - Draw 5 connected neighbor nodes
   - Animate pulsing rings from center outward
   - Animate the micro-boost traveling from center to neighbors

3. **Scroll animations** — `IntersectionObserver` for:
   - Fade-in + slide-up on each `.step-card`, `.feature-section`, `.lang-card`
   - Staggered delays (0.1s increments)
   - Only trigger once

4. **Email form interaction** — `#early-access-btn` click:
   - Show `#email-form`, hide button
   - `#email-submit` click: POST to `/api/waitlist` (endpoint we'll add), show success/error message
   - Same for footer CTA (`#early-access-btn-footer`)

5. **Nav scroll behavior** — navbar gets `nav-scrolled` class after 50px scroll (adds background opacity)

- [ ] **Step 2: Commit the landing JS**

```bash
cd /home/will/Desktop/LingLang && git add agents/src/dashboard/public/js/landing.js && git commit -m "feat: add landing page JS — Three.js hero, ripple animation, scroll effects, email capture"
```

---

### Task 5: Dashboard HTML

**Files:**
- Create: `agents/src/dashboard/public/dashboard.html`

- [ ] **Step 1: Create the dashboard HTML**

Create `agents/src/dashboard/public/dashboard.html` — a minimal viable dashboard with:

1. **Sidebar** (220px): LingLang logo, language switcher (6 language pills), navigation (Progress, Vocabulary, Goals, Connect)
2. **Top bar**: User identity text, service health indicator dot
3. **Main content area**: Dynamically rendered by `dashboard.js`
4. **Connect section**: Instructions for CLI start, service status cards (STT, TTS, LLM, Ollama models), GPU memory bar

The HTML is a shell — all content is rendered by JS from API data. Includes links to `css/design-tokens.css`, `css/dashboard.css`, and `js/dashboard.js`.

Key HTML structure:
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LingLang Dashboard</title>
  <link rel="stylesheet" href="css/design-tokens.css">
  <link rel="stylesheet" href="css/dashboard.css">
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🗣</text></svg>">
</head>
<body>
  <div class="app-layout">
    <!-- Sidebar -->
    <aside class="sidebar" id="sidebar">
      <div class="sidebar-header">
        <a href="/" class="sidebar-logo font-display">LingLang</a>
      </div>
      <nav class="sidebar-nav">
        <a href="#" data-view="progress" class="nav-link active">Progress</a>
        <a href="#" data-view="vocabulary" class="nav-link">Vocabulary</a>
        <a href="#" data-view="goals" class="nav-link">Goals</a>
        <a href="#" data-view="connect" class="nav-link">Connect</a>
      </nav>
      <div class="sidebar-lang" id="language-switcher">
        <div class="lang-pills">
          <button class="lang-pill active" data-lang="ru">🇷🇺</button>
          <button class="lang-pill" data-lang="es">🇪🇸</button>
          <button class="lang-pill" data-lang="fr">🇫🇷</button>
          <button class="lang-pill" data-lang="pt">🇵🇹</button>
          <button class="lang-pill" data-lang="ar">🇸🇦</button>
          <button class="lang-pill" data-lang="en">🇬🇧</button>
        </div>
      </div>
    </aside>

    <!-- Main -->
    <main class="main-content" id="main-content">
      <header class="top-bar">
        <div class="top-bar-left">
          <h2 class="top-bar-title font-display" id="page-title">Progress</h2>
        </div>
        <div class="top-bar-right">
          <div class="service-health" id="service-health">
            <span class="health-dot"></span>
            <span class="health-text">Connecting…</span>
          </div>
        </div>
      </header>
      <div class="content-area" id="content-area">
        <!-- Rendered by dashboard.js -->
        <div class="loading-state">
          <div class="loading-spinner"></div>
          <p class="text-muted">Loading dashboard data…</p>
        </div>
      </div>
    </main>
  </div>
  <script src="js/dashboard.js"></script>
</body>
</html>
```

- [ ] **Step 2: Commit dashboard HTML**

```bash
cd /home/will/Desktop/LingLang && git add agents/src/dashboard/public/dashboard.html && git commit -m "feat: add dashboard HTML shell with sidebar, language switcher, and content area"
```

---

### Task 6: Dashboard CSS

**Files:**
- Create: `agents/src/dashboard/public/css/dashboard.css`

- [ ] **Step 1: Create the dashboard stylesheet**

Create `agents/src/dashboard/public/css/dashboard.css` with styles for:

1. **App layout** — CSS grid: sidebar + main, min-width 1024px
2. **Sidebar** — Fixed 220px, dark surface-low, logo, nav links with active state, language pill selector
3. **Top bar** — flex, aligns title left and health indicator right
4. **Content area** — padding, scroll
5. **Cards** — `.stat-card`, `.info-card`, surface-low background, hover to surface-high
6. **Progress view** — Grid layout for today's summary (3 stat cards), FSRS distribution bar, stability chart placeholder, active goal card
7. **Vocabulary table** — Striped rows, sort indicators, state badge colors, search/filter bar
8. **Goals view** — Timeline-style list, active goal highlighted in secondary color
9. **Connect view** — Command block (monospace, surface-well bg), service status cards, GPU VRAM bar
10. **Loading state** — Spinner animation using CSS keyframes

- [ ] **Step 2: Commit dashboard CSS**

```bash
cd /home/will/Desktop/LingLang && git add agents/src/dashboard/public/css/dashboard.css && git commit -m "feat: add dashboard stylesheet with sidebar, cards, and table styles"
```

---

### Task 7: Dashboard JavaScript

**Files:**
- Create: `agents/src/dashboard/public/js/dashboard.js`

- [ ] **Step 1: Create the dashboard JavaScript**

Create `agents/src/dashboard/public/js/dashboard.js` with:

1. **State management** — Simple object holding: selectedLang, currentView, userData, vocabData, goalsData, serviceData
2. **API functions** — `fetchUser()`, `fetchVocabulary(lang)`, `fetchGoals()`, `fetchServices()`, `fetchActivity()`, `fetchStats()` — all using fetch to `/api/*`
3. **Language switcher** — Click handlers on `.lang-pill` buttons, update `selectedLang`, re-fetch vocabulary
4. **Nav switching** — Click handlers on `.nav-link`, set `currentView`, call appropriate render function
5. **Render: Progress view** — 
   - Today's summary: 3 stat cards (reviews due, words learned, avg stability)
   - FSRS distribution: horizontal stacked bar showing New/Learning/Review/Relearning percentages
   - Active goal card
   - Recent activity from `/api/activity`
6. **Render: Vocabulary view** — 
   - Search input + state filter buttons
   - Table with columns: Word, Translation, State (badge), Stability, Due
   - Populate from `/api/vocabulary/:userId`
7. **Render: Goals view** — 
   - List active/completed goals from `/api/users/:userId`
8. **Render: Connect view** — 
   - Start command: `cd /home/will/Desktop/LingLang/agents && pnpm dev:tutor-ed`
   - Service health cards with uptime dots (from `/api/services`)
   - GPU VRAM usage bar (from `/api/services`)
   - Runtime state card (from `/api/runtime`)
9. **Service health indicator** — Poll `/api/services` every 30s, update dot color (green/red)
10. **Init** — On DOMContentLoaded, detect user from URL param or default, fetch initial data, render Progress view

All API calls should use a default userId of `'test-user'` with a way to override via `?user=` URL parameter.

- [ ] **Step 2: Commit dashboard JS**

```bash
cd /home/will/Desktop/LingLang && git add agents/src/dashboard/public/js/dashboard.js && git commit -m "feat: add dashboard JS — data fetching, rendering, and interactions"
```

---

### Task 8: Server Routes for New Pages

**Files:**
- Modify: `agents/src/dashboard/server.ts`

- [ ] **Step 1: Add route handling for landing page and dashboard**

Open `agents/src/dashboard/server.ts`. Before the existing `app.use(express.static(...))` line (which is at the end), add the following routes:

1. **`GET /`** — Send `index.html` from the public directory (landing page). Use `path.join(__dirname, 'public', 'index.html')` and `res.sendFile()`.
2. **`GET /dashboard`** — Send `dashboard.html` from the public directory. Same pattern.
3. **`GET /api/vocabulary/:language`** — New endpoint. Accept a language code, query `lexemes` + `userVocabulary` for that language and a default user, return the joined data. This is for the dashboard vocabulary filter-by-language feature.

The static middleware (`app.use(express.static(...))`) must remain AFTER these routes so that CSS/JS files are still served.

Also add: import `path` from `node:path` and `fileURLToPath` from `node:url` at the top (they may already be there).

Add the `/api/vocabulary/:language` endpoint:
```typescript
app.get('/api/vocabulary/:language', async (req, res) => {
  try {
    const { language } = req.params;
    const { userId = 'test-user', limit = '200' } = req.query;

    const user = await db.query.users.findFirst({
      where: eq(users.id, userId as string)
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get vocabulary progress for this user in this language
    const progress = await db.query.userVocabulary.findMany({
      where: and(
        eq(userVocabulary.userId, userId as string),
      ),
      with: { lexeme: true },
      orderBy: [desc(userVocabulary.lastReview)],
      limit: parseInt(limit as string),
    });

    // Filter to the requested language
    const filtered = progress.filter(p => p.lexeme.language === language);

    res.json(filtered);
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});
```

- [ ] **Step 2: Add the waitlist email endpoint**

Add a simple `POST /api/waitlist` endpoint that accepts `{ email }` and appends it to a file (`data/waitlist.txt`):

```typescript
app.post('/api/waitlist', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email required' });
    }
    const fs = await import('node:fs/promises');
    const waitlistPath = path.join(__dirname, '..', '..', 'data', 'waitlist.txt');
    await fs.mkdir(path.dirname(waitlistPath), { recursive: true });
    await fs.appendFile(waitlistPath, `${new Date().toISOString()},${email}\n`);
    console.log(`[Waitlist] ${email}`);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: String(error) });
  }
});
```

Create the `data/` directory: `mkdir -p agents/data`

- [ ] **Step 3: Verify the server compiles**

Run: `cd /home/will/Desktop/LingLang/agents && npx tsx --eval "import './src/dashboard/server.js'" &` (quick syntax check, or just verify imports resolve)

Actually, simpler check — just look for TypeScript errors:
Run: `cd /home/will/Desktop/LingLang/agents && npx tsc --noEmit --pretty src/dashboard/server.ts 2>&1 | head -30`

Expected: No errors, or small type warnings only.

- [ ] **Step 4: Commit**

```bash
cd /home/will/Desktop/LingLang && git add agents/src/dashboard/server.ts agents/data/ && git commit -m "feat: add landing/dashboard routes and waitlist + vocabulary-by-language API endpoints"
```

---

### Task 9: Polish & Integration Testing

**Files:**
- Potentially modify all frontend files for polish

- [ ] **Step 1: Start the dashboard server**

Run: `cd /home/will/Desktop/LingLang/agents && npx tsx src/dashboard/server.ts >> /tmp/dashboard.log 2>&1 &`

- [ ] **Step 2: Verify landing page loads**

Open `http://localhost:3001/` in browser (or use Playwright). Check:
- Hero section renders with 3D animation
- All sections visible: How It Works, 3 features, Languages, CTA, Footer
- CSS tokens applied correctly (dark theme, no borders, Manrope/Inter fonts)
- Email form shows on "Get Early Access" click
- Scroll animations trigger on scroll

- [ ] **Step 3: Verify dashboard loads**

Open `http://localhost:3001/dashboard`. Check:
- Sidebar renders with language pills
- Navigation switches views
- Progress view shows data (or loading state if no user)
- Vocabulary table renders
- Service health indicator polls

- [ ] **Step 4: Verify API endpoints work**

```bash
curl -s http://localhost:3001/api/stats | head -20
curl -s http://localhost:3001/api/services | head -20
curl -s http://localhost:3001/api/vocabulary/ru?userId=test-user | head -20
curl -s -X POST http://localhost:3001/api/waitlist -H 'Content-Type: application/json' -d '{"email":"test@example.com"}'
```

Expected: JSON responses, waitlist email appended.

- [ ] **Step 5: Fix any issues found during testing**

Make targeted CSS/HTML/JS fixes for any visual or functional problems.

- [ ] **Step 6: Kill the test server**

```bash
pkill -f "tsx src/dashboard/server.ts" 2>/dev/null; true
```

- [ ] **Step 7: Final commit**

```bash
cd /home/will/Desktop/LingLang && git add -A && git commit -m "feat: complete LingLang landing page and dashboard — polish and integration fixes"
```

---

### Task 10: Nginx Configuration Update

**Files:**
- Modify: `/home/will/Desktop/new server/nginx-reverse-proxy.conf` (on remote server, not in this repo)

- [ ] **Step 1: Ensure nginx serves the landing page and dashboard correctly**

The existing nginx config at `app.senilelines.com` proxies everything to port 3001. The Express static middleware and our new routes should handle `/` and `/dashboard` correctly. No nginx changes should be needed since the Express server now handles these routes.

However, verify that the existing nginx config doesn't strip paths or add trailing slashes. Check:
- `https://app.senilelines.com/` → Express serves `index.html`
- `https://app.senilelines.com/dashboard` → Express serves `dashboard.html`
- `https://app.senilelines.com/css/design-tokens.css` → Express static serves CSS
- `https://app.senilelines.com/js/landing.js` → Express static serves JS
- `https://app.senilelines.com/api/stats` → Express API

If there are issues, may need to add `try_files` or adjust the proxy config. This is a verification step — only make changes if needed.

- [ ] **Step 2: Document the deployment**

No commit needed for this task unless nginx config changes. The verification is the deliverable.

---

## Self-Review Checklist

- **Spec coverage:** ✅ Landing page (hero, how it works, 3 features, languages, CTA, footer) — Task 2-4. ✅ Dashboard (progress, vocabulary, goals, connect) — Tasks 5-7. ✅ Server routes — Task 8. ✅ Design tokens — Task 1.
- **Placeholder scan:** ✅ All HTML, CSS, and JS contains actual content and styles. No TBD/TODO items.
- **Type consistency:** ✅ API endpoints use the same userId pattern as existing code. ✅ CSS class names are consistent between HTML and CSS files. ✅ JS uses the same class names for DOM queries.