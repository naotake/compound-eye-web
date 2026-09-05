// ========================================================================
// Generators (melody / rhythm generation framework)
// 並列 Generator、各 Generator は method と instrument を持つ
// 実際の method 実装は melody.js 側で行う（monkey-patch される）
// ========================================================================

const GEN_METHODS = ['phrase-melody', 'chord-pad', 'bass-root'];
const GEN_METHOD_LABELS = {
  'phrase-melody': '♪ Phrase Melody (lead)',
  'chord-pad':     '♪ Chord Pad (harmony)',
  'bass-root':     '♪ Bass (root+5th)',
};

const GEN_INSTRUMENTS = ['sine', 'triangle', 'square', 'sawtooth', 'am-bell', 'fm-pluck', 'pulse', 'soft-pad'];
const GEN_INSTRUMENT_LABELS = {
  'sine':      'Sine (pad)',
  'triangle':  'Triangle',
  'square':    'Square',
  'sawtooth':  'Sawtooth',
  'am-bell':   'AM Bell',
  'fm-pluck':  'FM Pluck',
  'pulse':     'Pulse',
  'soft-pad':  'Soft Pad',
};

const GEN_OCT_OPTIONS = [-2, -1, 0, 1, 2];

let genIdCounter = 0;
const generators = [];

function makeGen(method = 'phrase-melody', instrument = 'triangle') {
  genIdCounter++;
  return {
    id: genIdCounter,
    on: true,
    method,
    instrument,
    gain: 0.35,
    octaveShift: 0,
    synth: null,
    gainNode: null,
    attack: 0.02,
    release: 1.0,
    // timing
    lastFireTime: 0,
    nextFireTime: 0,
    // chord state (phrase-melody / chord-pad / bass-root shared)
    chordState: null,
  };
}

function buildInstrument(gen) {
  if (gen.synth && gen.synth.dispose) try { gen.synth.dispose(); } catch(e) {}
  if (gen.gainNode && gen.gainNode.dispose) try { gen.gainNode.dispose(); } catch(e) {}

  const gainNode = new Tone.Gain(gen.gain);
  gainNode.connect(engine.filter);
  gen.gainNode = gainNode;

  let synth;
  switch (gen.instrument) {
    case 'sine':
      synth = new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: 'sine' },
        envelope: { attack: gen.attack, decay: 0.2, sustain: 0.5, release: gen.release },
        volume: -8,
      });
      break;
    case 'triangle':
      synth = new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: 'triangle' },
        envelope: { attack: gen.attack, decay: 0.2, sustain: 0.5, release: gen.release },
        volume: -10,
      });
      break;
    case 'square':
      synth = new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: 'square' },
        envelope: { attack: gen.attack, decay: 0.2, sustain: 0.3, release: gen.release },
        volume: -18,
      });
      break;
    case 'sawtooth':
      synth = new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: 'sawtooth' },
        envelope: { attack: gen.attack, decay: 0.2, sustain: 0.4, release: gen.release },
        volume: -16,
      });
      break;
    case 'am-bell':
      synth = new Tone.PolySynth(Tone.AMSynth, {
        harmonicity: 3.5,
        oscillator: { type: 'sine' },
        modulation: { type: 'square' },
        envelope: { attack: gen.attack, decay: 0.3, sustain: 0.2, release: gen.release },
        volume: -14,
      });
      break;
    case 'fm-pluck':
      synth = new Tone.PolySynth(Tone.FMSynth, {
        harmonicity: 2.5,
        modulationIndex: 5,
        oscillator: { type: 'sine' },
        envelope: { attack: gen.attack, decay: 0.4, sustain: 0.1, release: gen.release },
        volume: -14,
      });
      break;
    case 'pulse':
      // PulseOscillator は width が可変。静的に 0.3 程度でナローハーフ気味。
      synth = new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: 'pulse', width: 0.3 },
        envelope: { attack: gen.attack, decay: 0.25, sustain: 0.45, release: gen.release },
        volume: -14,
      });
      break;
    case 'soft-pad':
      // fatsine (detune された sine 複数) + 長め ADSR で柔らかいパッド
      synth = new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: 'fatsine', count: 3, spread: 20 },
        envelope: { attack: Math.max(gen.attack, 0.3), decay: 0.4, sustain: 0.7, release: Math.max(gen.release, 1.5) },
        volume: -10,
      });
      break;
    default:
      synth = new Tone.PolySynth(Tone.Synth, { volume: -10 });
  }
  synth.maxPolyphony = 12;
  synth.connect(gainNode);
  gen.synth = synth;
}

function disposeGenAudio(gen) {
  try { if (gen.synth && gen.synth.releaseAll) gen.synth.releaseAll(); } catch(e) {}
  try { if (gen.synth && gen.synth.dispose) gen.synth.dispose(); } catch(e) {}
  try { if (gen.gainNode && gen.gainNode.dispose) gen.gainNode.dispose(); } catch(e) {}
  gen.synth = null;
  gen.gainNode = null;
}

function addGenerator(method = 'phrase-melody', instrument = 'triangle') {
  const gen = makeGen(method, instrument);
  generators.push(gen);
  renderGenList();
  if (engine.started) buildInstrument(gen);
  return gen;
}

function removeGenerator(id) {
  const idx = generators.findIndex(g => g.id === id);
  if (idx < 0) return;
  disposeGenAudio(generators[idx]);
  generators.splice(idx, 1);
  renderGenList();
}

function renderGenList() {
  const root = document.getElementById('genList');
  if (!root) return;
  root.innerHTML = '';
  for (const gen of generators) {
    const row = document.createElement('div');
    row.className = 'gen-row' + (gen.on ? ' active' : '');
    row.dataset.genId = gen.id;

    const methodOptions = GEN_METHODS.map(m =>
      `<option value="${m}" ${m === gen.method ? 'selected' : ''}>${GEN_METHOD_LABELS[m]}</option>`
    ).join('');
    const instOptions = GEN_INSTRUMENTS.map(i =>
      `<option value="${i}" ${i === gen.instrument ? 'selected' : ''}>${GEN_INSTRUMENT_LABELS[i]}</option>`
    ).join('');
    const octOptions = GEN_OCT_OPTIONS.map(o =>
      `<option value="${o}" ${o === gen.octaveShift ? 'selected' : ''}>${o >= 0 ? '+' : ''}${o} oct</option>`
    ).join('');

    row.innerHTML = `
      <div class="gen-top">
        <label><input type="checkbox" data-gen-on="${gen.id}" ${gen.on ? 'checked' : ''}> <strong>G${gen.id}</strong></label>
        <select data-gen-method="${gen.id}">${methodOptions}</select>
        <select data-gen-inst="${gen.id}">${instOptions}</select>
        <select data-gen-oct="${gen.id}">${octOptions}</select>
        <button class="del-gen" data-gen-del="${gen.id}">✕</button>
      </div>
      <div class="gen-params" data-gen-params="${gen.id}"></div>
    `;
    root.appendChild(row);
    renderGenParams(gen);
  }

  for (const gen of generators) {
    document.querySelector(`[data-gen-on="${gen.id}"]`).addEventListener('change', e => {
      gen.on = e.target.checked;
      const row = document.querySelector(`.gen-row[data-gen-id="${gen.id}"]`);
      if (row) row.classList.toggle('active', gen.on);
      if (!gen.on && gen.synth && gen.synth.releaseAll) gen.synth.releaseAll();
    });
    document.querySelector(`[data-gen-method="${gen.id}"]`).addEventListener('change', e => {
      gen.method = e.target.value;
      renderGenParams(gen);
      gen.chordState = null;
    });
    document.querySelector(`[data-gen-inst="${gen.id}"]`).addEventListener('change', e => {
      gen.instrument = e.target.value;
      if (engine.started) buildInstrument(gen);
    });
    document.querySelector(`[data-gen-oct="${gen.id}"]`).addEventListener('change', e => {
      gen.octaveShift = parseInt(e.target.value, 10);
    });
    document.querySelector(`[data-gen-del="${gen.id}"]`).addEventListener('click', () => {
      removeGenerator(gen.id);
    });
  }
}

// Note: renderGenParams is defined & patched in melody.js
// This base implementation is placeholder/fallback (method-specific params only in melody.js)
function renderGenParams(gen) {
  const box = document.querySelector(`[data-gen-params="${gen.id}"]`);
  if (!box) return;
  box.innerHTML = `
    <label>gain <input type="range" data-genp="${gen.id}:gain" min="0" max="1" step="0.01" value="${gen.gain}"></label>
    <label>attack <input type="range" data-genp="${gen.id}:attack" min="0.005" max="3" step="0.005" value="${gen.attack}"></label>
    <label>release <input type="range" data-genp="${gen.id}:release" min="0.05" max="6" step="0.05" value="${gen.release}"></label>
  `;
  box.querySelectorAll('[data-genp]').forEach(el => {
    el.addEventListener('input', e => {
      const [id, key] = e.target.dataset.genp.split(':');
      const g = generators.find(x => x.id === parseInt(id, 10));
      if (!g) return;
      const v = parseFloat(e.target.value);
      if (key === 'gain') {
        g.gain = v;
        if (g.gainNode) g.gainNode.gain.value = v;
      } else if (key === 'attack') {
        g.attack = v;
        if (g.synth) g.synth.set({ envelope: { attack: v } });
      } else if (key === 'release') {
        g.release = v;
        if (g.synth) g.synth.set({ envelope: { release: v } });
      } else {
        g[key] = v;
      }
    });
  });
}

// Default tickGenerators — will be monkey-patched by melody.js
// (Base does nothing; all method dispatching lives in melody.js)
function tickGenerators() {
  // no-op here; melody.js overrides
}

function generatorsOnEngineStart() {
  for (const gen of generators) buildInstrument(gen);
}
function generatorsOnEngineStop() {
  for (const gen of generators) disposeGenAudio(gen);
}

setInterval(() => { if (typeof window.tickGenerators === 'function') window.tickGenerators(); }, 50);

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btnAddGen').addEventListener('click', () => {
    addGenerator('phrase-melody', 'triangle');
  });
  // pre-populate a small ensemble so UI isn't empty
  addGenerator('phrase-melody', 'triangle');   // lead
  addGenerator('chord-pad', 'sine');           // harmony
  addGenerator('bass-root', 'sawtooth');       // bass
});
