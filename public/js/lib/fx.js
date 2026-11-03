/**
 * Canvas effects layer: missile trails, explosions, water splashes, shockwaves.
 * Runs independently of the DOM so grid re-renders never interrupt a shot.
 */

const MAX_PARTICLES = 900;

export class FxLayer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.projectiles = [];
    this.particles = [];
    this.rings = [];
    this.flashes = [];
    this.width = 0;
    this.height = 0;
    this.resize = this.resize.bind(this);
    this.loop = this.loop.bind(this);
    window.addEventListener('resize', this.resize);
    this.resize();
    requestAnimationFrame(this.loop);
  }

  resize() {
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    this.canvas.width = Math.floor(this.width * this.dpr);
    this.canvas.height = Math.floor(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  launch({ from, to, color = '#2ee6ff', duration = 720, onImpact = null, kind = 'missile' }) {
    this.projectiles.push({
      from: { ...from },
      to: { ...to },
      color,
      start: performance.now(),
      duration,
      onImpact,
      kind,
      trail: [],
    });
  }

  explosion(x, y, color = '#ff3b5c') {
    this.flashes.push({ x, y, life: 1, maxLife: 1, radius: 130, color });
    this.rings.push({ x, y, radius: 8, growth: 260, life: 1, maxLife: 1, color, width: 3 });

    for (let i = 0; i < 52; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 40 + Math.random() * 420;
      this.particles.push({
        x, y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        gravity: 160,
        size: 1 + Math.random() * 4,
        life: 1,
        maxLife: 0.45 + Math.random() * 0.7,
        color: Math.random() < 0.5 ? color : (Math.random() < 0.5 ? '#ffc857' : '#ff7a45'),
        drag: 0.985,
        kind: 'spark',
      });
    }

    for (let i = 0; i < 10; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      this.particles.push({
        x, y,
        vx: Math.cos(angle) * (20 + Math.random() * 60),
        vy: Math.sin(angle) * (20 + Math.random() * 60) - 30,
        gravity: -14,
        size: 10 + Math.random() * 26,
        life: 1,
        maxLife: 0.8 + Math.random() * 0.9,
        color: 'rgba(255, 120, 90, 0.16)',
        drag: 0.96,
        kind: 'smoke',
      });
    }
  }

  splash(x, y) {
    this.rings.push({ x, y, radius: 4, growth: 130, life: 1, maxLife: 0.85, color: '#2ee6ff', width: 2 });
    this.rings.push({ x, y, radius: 2, growth: 80, life: 1, maxLife: 1.2, color: 'rgba(46,230,255,0.45)', width: 1 });

    for (let i = 0; i < 26; i += 1) {
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
      const speed = 90 + Math.random() * 240;
      this.particles.push({
        x, y,
        vx: Math.cos(angle) * speed * 0.6,
        vy: Math.sin(angle) * speed,
        gravity: 420,
        size: 1 + Math.random() * 3,
        life: 1,
        maxLife: 0.5 + Math.random() * 0.5,
        color: Math.random() < 0.4 ? '#bff8ff' : '#2ee6ff',
        drag: 0.99,
        kind: 'drop',
      });
    }
  }

  muzzle(x, y, color) {
    this.flashes.push({ x, y, life: 1, maxLife: 0.5, radius: 46, color });
  }

  loop(now) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);
    // Projectiles
    for (let i = this.projectiles.length - 1; i >= 0; i -= 1) {
      const projectile = this.projectiles[i];
      const raw = (now - projectile.start) / projectile.duration;
      const t = Math.min(1, Math.max(0, raw));
      const eased = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
      const x = projectile.from.x + (projectile.to.x - projectile.from.x) * eased;
      const y = projectile.from.y + (projectile.to.y - projectile.from.y) * eased;
      // Slight arc for a launched missile.
      const arc = Math.sin(eased * Math.PI) * Math.min(90, Math.abs(projectile.to.x - projectile.from.x) * 0.08);
      const drawY = y - arc;

      projectile.trail.push({ x, y: drawY });
      if (projectile.trail.length > 22) projectile.trail.shift();

      ctx.save();
      ctx.lineCap = 'round';
      for (let p = 1; p < projectile.trail.length; p += 1) {
        const a = (p / projectile.trail.length) * 0.7;
        ctx.strokeStyle = projectile.color;
        ctx.globalAlpha = a;
        ctx.lineWidth = (p / projectile.trail.length) * 4;
        ctx.beginPath();
        ctx.moveTo(projectile.trail[p - 1].x, projectile.trail[p - 1].y);
        ctx.lineTo(projectile.trail[p].x, projectile.trail[p].y);
        ctx.stroke();
      }

      ctx.globalAlpha = 1;
      ctx.shadowColor = projectile.color;
      ctx.shadowBlur = 18;
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(x, drawY, 3.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      if (raw >= 1) {
        this.projectiles.splice(i, 1);
        if (projectile.kind === 'missile') {
          const impact = projectile.onImpact;
          // The caller decides hit/splash via its own callback.
          if (impact) impact();
        }
      }
    }

    // Shockwave rings
    for (let i = this.rings.length - 1; i >= 0; i -= 1) {
      const ring = this.rings[i];
      ring.life -= 0.016;
      ring.radius += ring.growth * 0.016;
      if (ring.life <= 0) {
        this.rings.splice(i, 1);
        continue;
      }
      const progress = 1 - ring.life / ring.maxLife;
      ctx.save();
      ctx.globalAlpha = Math.max(0, ring.life / ring.maxLife) * 0.9;
      ctx.strokeStyle = ring.color;
      ctx.lineWidth = ring.width * (1 - progress * 0.6);
      ctx.beginPath();
      ctx.arc(ring.x, ring.y, ring.radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    // Flashes
    for (let i = this.flashes.length - 1; i >= 0; i -= 1) {
      const flash = this.flashes[i];
      flash.life -= 0.05;
      if (flash.life <= 0) {
        this.flashes.splice(i, 1);
        continue;
      }
      const radius = flash.radius * (1.25 - flash.life * 0.5);
      const gradient = ctx.createRadialGradient(flash.x, flash.y, 0, flash.x, flash.y, radius);
      gradient.addColorStop(0, flash.color);
      gradient.addColorStop(0.35, 'rgba(255, 180, 120, 0.35)');
      gradient.addColorStop(1, 'transparent');
      ctx.save();
      ctx.globalAlpha = Math.max(0, flash.life) * 0.85;
      ctx.fillStyle = gradient;
      ctx.beginPath();
      ctx.arc(flash.x, flash.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Particles
    if (this.particles.length > MAX_PARTICLES) this.particles.splice(0, this.particles.length - MAX_PARTICLES);
    for (let i = this.particles.length - 1; i >= 0; i -= 1) {
      const particle = this.particles[i];
      particle.life -= 0.016 / particle.maxLife;
      if (particle.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      particle.vx *= particle.drag;
      particle.vy = particle.vy * particle.drag + particle.gravity * 0.016;
      particle.x += particle.vx * 0.016;
      particle.y += particle.vy * 0.016;

      ctx.save();
      ctx.globalAlpha = Math.min(1, particle.life * 1.6);
      ctx.fillStyle = particle.color;
      if (particle.kind === 'spark') {
        ctx.shadowColor = particle.color;
        ctx.shadowBlur = 10;
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, particle.size * particle.life, 0, Math.PI * 2);
        ctx.fill();
      } else if (particle.kind === 'smoke') {
        ctx.beginPath();
        ctx.arc(particle.x, particle.y, particle.size * (1.6 - particle.life), 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.ellipse(particle.x, particle.y, particle.size * 0.55, particle.size * 1.4, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // Schedule the next frame. Without this the layer renders a single frame
    // and projectiles never reach their impact callbacks.
    requestAnimationFrame(this.loop);
  }

  clear() {
    this.projectiles = [];
    this.particles = [];
    this.rings = [];
    this.flashes = [];
  }
}
