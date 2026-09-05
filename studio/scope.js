// ========================================================================
// Oscilloscope + Spectrum Visualizer
// engine.master に Analyser を挟んで、上半分=波形 下半分=スペクトル
// ========================================================================

const scope = {
  canvas: null,
  ctx: null,
  analyser: null,      // Tone.Analyser (waveform)
  fft: null,           // Tone.Analyser (fft)
  running: false,
};

function initScope() {
  if (scope.canvas) return;
  scope.canvas = document.getElementById('scope');
  if (!scope.canvas) return;
  scope.ctx = scope.canvas.getContext('2d');
  // resize for devicePixelRatio
  const resize = () => {
    const rect = scope.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    scope.canvas.width = rect.width * dpr;
    scope.canvas.height = rect.height * dpr;
    scope.ctx.scale(dpr, dpr);
  };
  resize();
  window.addEventListener('resize', () => {
    scope.canvas.width = scope.canvas.getBoundingClientRect().width * (window.devicePixelRatio || 1);
    scope.canvas.height = scope.canvas.getBoundingClientRect().height * (window.devicePixelRatio || 1);
  });
  requestAnimationFrame(tickScope);
}

function attachScope() {
  // Called after engine starts; hook Analyser to engine.master
  if (!scope.canvas) initScope();
  if (!engine.master) return;
  try {
    scope.analyser = new Tone.Analyser('waveform', 1024);
    scope.fft = new Tone.Analyser('fft', 256);
    engine.master.connect(scope.analyser);
    engine.master.connect(scope.fft);
    scope.running = true;
  } catch (e) {
    console.error('scope attach failed', e);
  }
}

function detachScope() {
  scope.running = false;
  try { if (scope.analyser) scope.analyser.dispose(); } catch(e) {}
  try { if (scope.fft) scope.fft.dispose(); } catch(e) {}
  scope.analyser = null;
  scope.fft = null;
  // clear canvas
  if (scope.ctx) {
    const r = scope.canvas.getBoundingClientRect();
    scope.ctx.clearRect(0, 0, r.width, r.height);
  }
}

function tickScope() {
  if (scope.ctx) drawScope();
  requestAnimationFrame(tickScope);
}

function drawScope() {
  const ctx = scope.ctx;
  const rect = scope.canvas.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  // fade
  ctx.fillStyle = 'rgba(20, 20, 28, 0.25)';
  ctx.fillRect(0, 0, w, h);

  if (!scope.running || !scope.analyser) {
    ctx.fillStyle = '#555';
    ctx.font = '11px monospace';
    ctx.fillText('(stopped)', 8, 16);
    return;
  }

  // --- top half: waveform ---
  const waveData = scope.analyser.getValue();
  ctx.strokeStyle = '#7acc7a';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  const halfH = h * 0.5;
  for (let i = 0; i < waveData.length; i++) {
    const x = (i / waveData.length) * w;
    const y = halfH * 0.5 + (waveData[i] * halfH * 0.45);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // center line
  ctx.strokeStyle = '#2a2a35';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, halfH);
  ctx.lineTo(w, halfH);
  ctx.stroke();

  // --- bottom half: spectrum ---
  if (scope.fft) {
    const fftData = scope.fft.getValue();
    const bw = w / fftData.length;
    ctx.fillStyle = '#c67acc';
    for (let i = 0; i < fftData.length; i++) {
      // fft values are in dB, typically -100..0
      const db = fftData[i];
      const mag = Math.max(0, (db + 100) / 100); // 0..1
      const bh = mag * halfH * 0.95;
      ctx.fillRect(i * bw, h - bh, Math.max(1, bw - 1), bh);
    }
  }

  // labels
  ctx.fillStyle = '#555';
  ctx.font = '10px monospace';
  ctx.fillText('wave', 4, 12);
  ctx.fillText('spec', 4, halfH + 14);
}

// hook into engine lifecycle
const _origStart = window.startEngine;
// We can't wrap here cleanly because startEngine is declared at top. Expose helpers instead.
window.scopeAttach = attachScope;
window.scopeDetach = detachScope;

// init on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initScope);
} else {
  initScope();
}
