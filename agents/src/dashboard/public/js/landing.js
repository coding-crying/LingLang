/**
 * LingLang Landing Page JavaScript
 * Three.js hero scene, ripple animation, scroll reveals, email capture
 */

// ============================================================================
// THREE.JS HERO SCENE
// ============================================================================

(function initHero() {
  const canvas = document.getElementById('hero-canvas');
  if (!canvas || typeof THREE === 'undefined') return;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.z = 5;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
  });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  // Icosahedron — main shape
  const icoGeo = new THREE.IcosahedronGeometry(1.6, 1);
  const icoMat = new THREE.MeshBasicMaterial({
    color: 0xb4c5ff,
    wireframe: true,
    transparent: true,
    opacity: 0.25,
  });
  const ico = new THREE.Mesh(icoGeo, icoMat);
  scene.add(ico);

  // Inner icosahedron — smaller, brighter
  const innerGeo = new THREE.IcosahedronGeometry(1.0, 1);
  const innerMat = new THREE.MeshBasicMaterial({
    color: 0x4edea3,
    wireframe: true,
    transparent: true,
    opacity: 0.15,
  });
  const innerIco = new THREE.Mesh(innerGeo, innerMat);
  scene.add(innerIco);

  // Particles
  const particleCount = 200;
  const positions = new Float32Array(particleCount * 3);
  const sizes = new Float32Array(particleCount);

  for (let i = 0; i < particleCount; i++) {
    const r = 2.5 + Math.random() * 2.5;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
    positions[i * 3 + 2] = r * Math.cos(phi);
    sizes[i] = 1.5 + Math.random() * 2;
  }

  const particleGeo = new THREE.BufferGeometry();
  particleGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  particleGeo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

  const particleMat = new THREE.PointsMaterial({
    color: 0x4edea3,
    size: 0.03,
    transparent: true,
    opacity: 0.6,
    sizeAttenuation: true,
  });
  const particles = new THREE.Points(particleGeo, particleMat);
  scene.add(particles);

  // Connection lines between nearby particles
  const linesMat = new THREE.LineBasicMaterial({
    color: 0x7bd0ff,
    transparent: true,
    opacity: 0.08,
  });
  const linesGeo = new THREE.BufferGeometry();
  const linesPositions = [];

  for (let i = 0; i < particleCount; i++) {
    for (let j = i + 1; j < particleCount; j++) {
      const dx = positions[i * 3] - positions[j * 3];
      const dy = positions[i * 3 + 1] - positions[j * 3 + 1];
      const dz = positions[i * 3 + 2] - positions[j * 3 + 2];
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist < 1.5) {
        linesPositions.push(
          positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2],
          positions[j * 3], positions[j * 3 + 1], positions[j * 3 + 2]
        );
      }
    }
  }

  linesGeo.setAttribute('position', new THREE.Float32BufferAttribute(linesPositions, 3));
  const lines = new THREE.LineSegments(linesGeo, linesMat);
  scene.add(lines);

  // Mouse parallax
  let mouseX = 0, mouseY = 0;
  document.addEventListener('mousemove', (e) => {
    mouseX = (e.clientX / window.innerWidth - 0.5) * 0.5;
    mouseY = (e.clientY / window.innerHeight - 0.5) * 0.5;
  });

  // Animation loop
  function animate() {
    requestAnimationFrame(animate);

    const t = Date.now() * 0.0005;

    ico.rotation.x = t * 0.3 + mouseY * 0.3;
    ico.rotation.y = t * 0.2 + mouseX * 0.3;

    innerIco.rotation.x = -t * 0.2 + mouseY * 0.2;
    innerIco.rotation.y = -t * 0.15 + mouseX * 0.2;

    particles.rotation.y = t * 0.05;
    particles.rotation.x = t * 0.03;

    lines.rotation.y = t * 0.05;
    lines.rotation.x = t * 0.03;

    // Subtle camera drift
    camera.position.x += (mouseX - camera.position.x) * 0.02;
    camera.position.y += (-mouseY - camera.position.y) * 0.02;
    camera.lookAt(0, 0, 0);

    renderer.render(scene, camera);
  }
  animate();

  // Resize
  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });
})();

// ============================================================================
// RIPPLE CANVAS ANIMATION
// ============================================================================

(function initRipple() {
  const canvas = document.getElementById('ripple-canvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  // Set canvas size
  function resize() {
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    ctx.scale(dpr, dpr);
  }
  resize();
  window.addEventListener('resize', resize);

  // Word nodes
  const center = { x: 220, y: 170, word: 'яблоко', sub: 'apple', isCenter: true };
  const neighbors = [
    { x: 100, y: 90, word: 'груша', sub: 'pear' },
    { x: 340, y: 80, word: 'фрукт', sub: 'fruit' },
    { x: 80, y: 220, word: 'вишня', sub: 'cherry' },
    { x: 350, y: 230, word: 'сок', sub: 'juice' },
    { x: 220, y: 295, word: 'дерево', sub: 'tree' },
  ];

  let pulseRadius = 0;
  let pulseAlpha = 0.6;
  let frame = 0;

  function draw() {
    frame++;
    const w = canvas.width / dpr;
    const h = canvas.height / dpr;
    ctx.clearRect(0, 0, w, h);

    // Draw connections
    ctx.strokeStyle = 'rgba(123, 208, 255, 0.15)';
    ctx.lineWidth = 1;
    neighbors.forEach(n => {
      ctx.beginPath();
      ctx.moveTo(center.x, center.y);
      ctx.lineTo(n.x, n.y);
      ctx.stroke();
    });

    // Draw connections between neighbors that are close
    ctx.strokeStyle = 'rgba(123, 208, 255, 0.06)';
    const allNodes = [center, ...neighbors];
    for (let i = 0; i < allNodes.length; i++) {
      for (let j = i + 1; j < allNodes.length; j++) {
        const dx = allNodes[i].x - allNodes[j].x;
        const dy = allNodes[i].y - allNodes[j].y;
        if (Math.sqrt(dx * dx + dy * dy) < 180) {
          ctx.beginPath();
          ctx.moveTo(allNodes[i].x, allNodes[i].y);
          ctx.lineTo(allNodes[j].x, allNodes[j].y);
          ctx.stroke();
        }
      }
    }

    // Pulse from center
    pulseRadius += 0.8;
    pulseAlpha -= 0.004;
    if (pulseAlpha <= 0 || pulseRadius > 200) {
      pulseRadius = 0;
      pulseAlpha = 0.6;
    }

    ctx.beginPath();
    ctx.arc(center.x, center.y, pulseRadius, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(78, 222, 163, ${pulseAlpha})`;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Boost particles traveling to neighbors
    const boostPhase = (frame % 240) / 240; // 0 to 1 over 4 seconds
    neighbors.forEach((n, i) => {
      const offset = i * 0.18;
      const t = (boostPhase + offset) % 1;
      const bx = center.x + (n.x - center.x) * t;
      const by = center.y + (n.y - center.y) * t;
      ctx.beginPath();
      ctx.arc(bx, by, 2, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(78, 222, 163, ${0.8 * (1 - Math.abs(t - 0.5) * 2)})`;
      ctx.fill();
    });

    // Draw center node
    ctx.beginPath();
    ctx.arc(center.x, center.y, 22, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(78, 222, 163, 0.2)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(78, 222, 163, 0.8)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#dae2fd';
    ctx.font = 'bold 11px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(center.word, center.x, center.y - 4);
    ctx.fillStyle = '#909097';
    ctx.font = '9px Inter, sans-serif';
    ctx.fillText(center.sub, center.x, center.y + 10);

    // Draw neighbor nodes
    neighbors.forEach(n => {
      ctx.beginPath();
      ctx.arc(n.x, n.y, 16, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(19, 27, 46, 0.8)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(180, 197, 255, 0.4)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.fillStyle = '#dae2fd';
      ctx.font = 'bold 9px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(n.word, n.x, n.y - 3);
      ctx.fillStyle = '#909097';
      ctx.font = '8px Inter, sans-serif';
      ctx.fillText(n.sub, n.x, n.y + 8);
    });

    requestAnimationFrame(draw);
  }
  draw();
})();

// ============================================================================
// SCROLL REVEAL
// ============================================================================

(function initScrollReveal() {
  const reveals = document.querySelectorAll('.reveal');
  if (!reveals.length) return;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -50px 0px' });

  reveals.forEach(el => observer.observe(el));
})();

// ============================================================================
// NAVIGATION SCROLL
// ============================================================================

(function initNav() {
  const nav = document.getElementById('nav');
  if (!nav) return;

  function onScroll() {
    if (window.scrollY > 50) {
      nav.classList.add('nav-scrolled');
    } else {
      nav.classList.remove('nav-scrolled');
    }
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
})();

// ============================================================================
// EMAIL FORM
// ============================================================================

(function initEmailForms() {
  function setupForm(btnId, formId, inputId, submitId, statusId) {
    const btn = document.getElementById(btnId);
    const form = document.getElementById(formId);
    const input = document.getElementById(inputId);
    const submit = document.getElementById(submitId);
    const status = document.getElementById(statusId);

    if (!btn || !form) return;

    btn.addEventListener('click', () => {
      form.classList.add('active');
      btn.style.display = 'none';
      if (input) input.focus();
    });

    if (submit) {
      submit.addEventListener('click', async () => {
        const email = input ? input.value.trim() : '';
        if (!email || !email.includes('@')) {
          if (status) {
            status.textContent = 'Please enter a valid email address.';
            status.className = 'email-status error';
          }
          return;
        }

        submit.disabled = true;
        submit.textContent = 'Joining...';

        try {
          const res = await fetch('/api/waitlist', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email }),
          });
          const data = await res.json();

          if (data.success) {
            if (status) {
              status.textContent = 'You\'re on the waitlist! We\'ll be in touch.';
              status.className = 'email-status success';
            }
          } else {
            if (status) {
              status.textContent = data.error || 'Something went wrong. Please try again.';
              status.className = 'email-status error';
            }
          }
        } catch (e) {
          if (status) {
            status.textContent = 'Could not connect. Please try again later.';
            status.className = 'email-status error';
          }
        }

        submit.disabled = false;
        submit.textContent = 'Join Waitlist';
      });
    }
  }

  setupForm('early-access-btn', 'email-form', 'email-input', 'email-submit', 'email-status');
  setupForm('early-access-btn-footer', 'email-form-footer', 'email-input-footer', 'email-submit-footer', 'email-status-footer');
})();

// ============================================================================
// SMOOTH SCROLL FOR ANCHOR LINKS
// ============================================================================

document.querySelectorAll('a[href^="#"]').forEach(anchor => {
  anchor.addEventListener('click', function (e) {
    e.preventDefault();
    const target = document.querySelector(this.getAttribute('href'));
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
});