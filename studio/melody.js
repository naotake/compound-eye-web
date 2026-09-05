// ========================================================================
// Melody Engine — A (phrase) + B (tonality) + C (role separation)
//
// 既存 generators.js の Generator 機構を拡張する。追加 method:
//   - 'phrase-melody' : 主役単旋律。コード進行に沿って隣接音中心でフレーズ生成
//   - 'chord-pad'     : コード進行のコード弾き
//   - 'bass-root'     : ルート音＋5度中心のベース
// ========================================================================

// ---- Chord progressions (scale degree form) ----
// I=0, ii=1, iii=2, IV=3, V=4, vi=5, vii=6 (diatonic triads)
const CHORD_PROGRESSIONS = {
  // common & stable progressions
  'I-V-vi-IV':   [0, 4, 5, 3],    // pop, uplifting
  'I-vi-IV-V':   [0, 5, 3, 4],    // 50s
  'vi-IV-I-V':   [5, 3, 0, 4],    // emotional
  'I-IV-V-I':    [0, 3, 4, 0],    // classic
  'ii-V-I':      [1, 4, 0],       // jazz turnaround
  'I-V-I':       [0, 4, 0],       // simple
  'I-vi-ii-V':   [0, 5, 1, 4],    // circle
};

// Build triad from scale degree (index into scale array)
function buildTriad(scale, keyMidi, octRoot, degree) {
  // degree = scale index (0-based)
  const root = scale[degree % scale.length];
  const third = scale[(degree + 2) % scale.length];
  const fifth = scale[(degree + 4) % scale.length];
  // handle octave wrap
  const thirdOct = (degree + 2 >= scale.length) ? 12 : 0;
  const fifthOct = (degree + 4 >= scale.length) ? 12 : 0;
  return [
    octRoot + keyMidi + root,
    octRoot + keyMidi + third + thirdOct,
    octRoot + keyMidi + fifth + fifthOct,
  ];
}

// Pick scale degree of the current chord (random weighted to chord tones)
function pickFromChord(chordMidis, scale, keyMidi, octRoot, preferChord = 0.7) {
  if (Math.random() < preferChord) {
    // return a chord tone
    return chordMidis[Math.floor(Math.random() * chordMidis.length)];
  } else {
    // return a passing tone (scale note near the chord root)
    const root = chordMidis[0] - octRoot - keyMidi; // back to scale offset
    // pick a scale degree
    const deg = scale[Math.floor(Math.random() * scale.length)];
    return octRoot + keyMidi + deg;
  }
}

// Initialize chord state on a generator
function ensureChordState(gen, m) {
  if (gen.chordState && gen.chordState.key === m.keyMidi && gen.chordState.progKey === gen.progression) return;
  const progression = CHORD_PROGRESSIONS[gen.progression] || CHORD_PROGRESSIONS['I-V-vi-IV'];
  gen.chordState = {
    key: m.keyMidi,
    progKey: gen.progression,
    progression,
    chordIdx: 0,
    chordStartTime: Tone.now(),
    chordDur: gen.chordDur || 4,  // seconds per chord
    lastPhaseInChord: 0,
    lastMidi: null,
    phraseStep: 0,          // within-phrase counter
    phraseLen: gen.phraseLen || 8,  // notes per phrase
  };
}

function advanceChord(gen, now) {
  const st = gen.chordState;
  if (!st) return;
  const elapsed = now - st.chordStartTime;
  if (elapsed >= st.chordDur) {
    st.chordIdx = (st.chordIdx + 1) % st.progression.length;
    st.chordStartTime = now;
  }
}

function currentChordMidis(gen, m) {
  const st = gen.chordState;
  const deg = st.progression[st.chordIdx];
  const octRoot = Math.floor(m.centerMidi / 12) * 12;
  return buildTriad(m.scale, m.keyMidi, octRoot, deg);
}

// ---- tick: phrase-melody ----
function tickPhraseMelody(gen, now, m) {
  ensureChordState(gen, m);
  advanceChord(gen, now);

  if (now < gen.nextFireTime) return;

  const chordMidis = currentChordMidis(gen, m);
  const octRoot = Math.floor(m.centerMidi / 12) * 12;

  const st = gen.chordState;
  const stepInterval = 1 / Math.max(0.1, gen.density);
  gen.nextFireTime = now + stepInterval * (0.85 + Math.random() * 0.3);

  // Decide whether to rest (pauses make phrases)
  const phrasePos = st.phraseStep / st.phraseLen;
  const restChance = phrasePos > 0.9 ? 0.6 : 0.15;  // more rest at phrase end
  if (Math.random() < restChance) {
    st.phraseStep = (st.phraseStep + 1) % st.phraseLen;
    return;
  }

  // Pick target note:
  //  - start of phrase: strong chord tone
  //  - middle: mix chord/passing, neighbor to last note
  //  - end: resolve to chord tone (preferably root)
  let targetMidi;
  if (st.phraseStep === 0 || st.lastMidi === null) {
    // start: pick a high-ish chord tone for clear melodic identity
    const highChord = chordMidis[chordMidis.length - 1] + 12; // octave up
    targetMidi = highChord + (gen.octaveShift || 0) * 12;
  } else if (st.phraseStep >= st.phraseLen - 1) {
    // end: resolve to chord root
    targetMidi = chordMidis[0] + 12 + (gen.octaveShift || 0) * 12;
  } else {
    // middle: neighbor step from last note within the scale
    const lastDegIdx = scaleIndexOf(st.lastMidi - octRoot - m.keyMidi, m.scale);
    const stepRange = gen.jumpRange || 2;  // small steps preferred
    const biasToChord = Math.random() < 0.5;
    if (biasToChord) {
      // pick chord tone nearest to last note
      const candidates = [
        ...chordMidis,
        ...chordMidis.map(c => c + 12),
        ...chordMidis.map(c => c - 12),
      ];
      candidates.sort((a, b) => Math.abs(a - st.lastMidi) - Math.abs(b - st.lastMidi));
      targetMidi = candidates[0] + (gen.octaveShift || 0) * 12;
    } else {
      // scale step neighbor
      const delta = Math.floor(Math.random() * (stepRange * 2 + 1)) - stepRange;
      const newDegIdx = (lastDegIdx + delta + m.scale.length * 4) % m.scale.length;
      // preserve octave roughly
      const octOffset = Math.floor((st.lastMidi - octRoot - m.keyMidi) / 12) * 12;
      targetMidi = octRoot + m.keyMidi + m.scale[newDegIdx] + octOffset + (gen.octaveShift || 0) * 12;
    }
  }

  // duration: longer at phrase boundaries
  const isEdge = st.phraseStep === 0 || st.phraseStep >= st.phraseLen - 1;
  const dur = isEdge ? stepInterval * 2.5 : stepInterval * (0.7 + Math.random() * 0.5);

  const freq = midiToFreq(targetMidi);
  try { gen.synth.triggerAttackRelease(freq, dur, now, 0.35 + Math.random() * 0.25); } catch(e) {}

  st.lastMidi = targetMidi;
  st.phraseStep = (st.phraseStep + 1) % st.phraseLen;
}

function scaleIndexOf(offset, scale) {
  // find nearest scale index
  let oct = Math.floor(offset / 12);
  let rem = ((offset % 12) + 12) % 12;
  let bestIdx = 0, bestDist = 99;
  for (let i = 0; i < scale.length; i++) {
    const d = Math.abs(scale[i] - rem);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  }
  return bestIdx;
}

// ---- tick: chord-pad ----
function tickChordPad(gen, now, m) {
  ensureChordState(gen, m);
  advanceChord(gen, now);
  const st = gen.chordState;

  if (now < gen.nextFireTime) return;
  gen.nextFireTime = now + (gen.chordDur || 4) * 0.95;

  const chordMidis = currentChordMidis(gen, m);
  const oct = (gen.octaveShift || 0) * 12;
  const dur = (gen.chordDur || 4) * 0.9;
  for (const midi of chordMidis) {
    const freq = midiToFreq(midi + oct);
    try { gen.synth.triggerAttackRelease(freq, dur, now + Math.random() * 0.05, 0.3); } catch(e) {}
  }
}

// ---- tick: bass-root ----
function tickBassRoot(gen, now, m) {
  ensureChordState(gen, m);
  advanceChord(gen, now);
  const st = gen.chordState;

  if (now < gen.nextFireTime) return;
  // bass pattern: root on beat, 5th on offbeat
  const beatDur = (gen.chordDur || 4) / (gen.bassBeats || 4);
  gen.nextFireTime = now + beatDur;

  const chordMidis = currentChordMidis(gen, m);
  const rootBase = chordMidis[0] - 24;  // two octaves down
  const fifthBase = chordMidis[2] - 24;
  const beat = Math.floor((now - st.chordStartTime) / beatDur) % (gen.bassBeats || 4);
  const midi = (beat === 0 || beat === 2) ? rootBase : fifthBase;
  const oct = (gen.octaveShift || 0) * 12;
  const freq = midiToFreq(midi + oct);
  try { gen.synth.triggerAttackRelease(freq, beatDur * 0.8, now, 0.5); } catch(e) {}
}

// ========================================================================
// Integration with generators.js
// ========================================================================

// extend GEN_METHODS and labels
// NOTE: generators.js now exports only ['phrase-melody','chord-pad','bass-root']
// so no additional methods to push here.

// hook into tickGenerators via monkey-patch
(function patchTickGenerators() {
  window.tickGenerators = function() {
    if (!engine.started) return;
    const now = Tone.now();
    const m = engine.musical;
    for (const gen of generators) {
      if (!gen.on || !gen.synth) continue;
      switch (gen.method) {
        case 'phrase-melody': tickPhraseMelody(gen, now, m); break;
        case 'chord-pad':     tickChordPad(gen, now, m); break;
        case 'bass-root':     tickBassRoot(gen, now, m); break;
      }
    }
  };
})();

// extend renderGenParams to show new method params
(function patchRenderGenParams() {
  const orig = window.renderGenParams;
  window.renderGenParams = function(gen) {
    const box = document.querySelector(`[data-gen-params="${gen.id}"]`);
    if (!box) return;

    const common = `
      <label>gain <input type="range" data-genp="${gen.id}:gain" min="0" max="1" step="0.01" value="${gen.gain}"></label>
      <label>attack <input type="range" data-genp="${gen.id}:attack" min="0.005" max="3" step="0.005" value="${gen.attack}"></label>
      <label>release <input type="range" data-genp="${gen.id}:release" min="0.05" max="6" step="0.05" value="${gen.release}"></label>
    `;

    let specific = '';
    if (gen.method === 'phrase-melody') {
      if (gen.progression === undefined) gen.progression = 'I-V-vi-IV';
      if (gen.density === undefined) gen.density = 2.0;
      if (gen.chordDur === undefined) gen.chordDur = 4;
      if (gen.phraseLen === undefined) gen.phraseLen = 8;
      if (gen.jumpRange === undefined) gen.jumpRange = 2;
      const progOpts = Object.keys(CHORD_PROGRESSIONS).map(k =>
        `<option value="${k}" ${k === gen.progression ? 'selected' : ''}>${k}</option>`
      ).join('');
      specific = `
        <label>progression <select data-genp-str="${gen.id}:progression">${progOpts}</select></label>
        <label>density <input type="range" data-genp="${gen.id}:density" min="0.5" max="6" step="0.1" value="${gen.density}"></label>
        <label>chord dur <input type="range" data-genp="${gen.id}:chordDur" min="1" max="10" step="0.5" value="${gen.chordDur}"></label>
        <label>phrase len <input type="range" data-genp="${gen.id}:phraseLen" min="3" max="16" step="1" value="${gen.phraseLen}"></label>
        <label>jump range <input type="range" data-genp="${gen.id}:jumpRange" min="1" max="5" step="1" value="${gen.jumpRange}"></label>
      `;
    } else if (gen.method === 'chord-pad') {
      if (gen.progression === undefined) gen.progression = 'I-V-vi-IV';
      if (gen.chordDur === undefined) gen.chordDur = 4;
      const progOpts = Object.keys(CHORD_PROGRESSIONS).map(k =>
        `<option value="${k}" ${k === gen.progression ? 'selected' : ''}>${k}</option>`
      ).join('');
      specific = `
        <label>progression <select data-genp-str="${gen.id}:progression">${progOpts}</select></label>
        <label>chord dur <input type="range" data-genp="${gen.id}:chordDur" min="1" max="10" step="0.5" value="${gen.chordDur}"></label>
      `;
    } else if (gen.method === 'bass-root') {
      if (gen.progression === undefined) gen.progression = 'I-V-vi-IV';
      if (gen.chordDur === undefined) gen.chordDur = 4;
      if (gen.bassBeats === undefined) gen.bassBeats = 4;
      const progOpts = Object.keys(CHORD_PROGRESSIONS).map(k =>
        `<option value="${k}" ${k === gen.progression ? 'selected' : ''}>${k}</option>`
      ).join('');
      specific = `
        <label>progression <select data-genp-str="${gen.id}:progression">${progOpts}</select></label>
        <label>chord dur <input type="range" data-genp="${gen.id}:chordDur" min="1" max="10" step="0.5" value="${gen.chordDur}"></label>
        <label>bass beats <input type="range" data-genp="${gen.id}:bassBeats" min="1" max="8" step="1" value="${gen.bassBeats}"></label>
      `;
    }

    box.innerHTML = common + specific;

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
        // invalidate chord state when progression-related param changes
        if (['chordDur', 'progression', 'phraseLen'].includes(key)) {
          if (g.chordState) g.chordState.progKey = null;
        }
      });
    });
    box.querySelectorAll('[data-genp-str]').forEach(el => {
      el.addEventListener('change', e => {
        const [id, key] = e.target.dataset.genpStr.split(':');
        const g = generators.find(x => x.id === parseInt(id, 10));
        if (!g) return;
        g[key] = e.target.value;
        if (g.chordState) g.chordState.progKey = null;
      });
    });
  };
})();

// ========================================================================
// Apply image-derived musical state to existing generators.
// Called from applyImageMapping() in compound_eye_studio.html.
// 案A: 既存 generators を全削除して画像から再構築する
// ========================================================================
window.applyMusicalToGenerators = function(m, f) {
  const gens = (typeof generators !== 'undefined') ? generators : (window.generators || []);
  if (!gens) return;

  // 画像特徴から roster (generator 構成) を決定
  const ed = f.edge_density || 0;
  const lc = f.local_contrast || 0;
  const bv = f.brightness_variance || 0;
  const sv = f.saturation_variance || 0;
  const hent = f.hue_entropy || 0;
  const skew = f.brightness_skewness !== undefined ? f.brightness_skewness : 0.5;
  const vdiff = f.brightness_vertical_diff !== undefined ? f.brightness_vertical_diff : 0.5;
  const complexity = Math.min(1, ed * 0.8 + lc * 0.6 + bv * 0.4 + sv * 0.3);

  // instrument 選択ヘルパー
  const pickBassInst = () => skew < 0.4 ? 'sawtooth' : 'triangle';
  const pickLeadInst = (variant = 0) => {
    // variant 0: 主旋律 / 1: 2本目の別キャラ
    if (variant === 0) {
      if (skew > 0.65) return hent > 0.5 ? 'fm-pluck' : 'triangle';
      if (skew < 0.35) return hent > 0.5 ? 'am-bell' : 'sine';
      // 中間帯: complexity が高いと pulse (おもちゃ系)
      return complexity > 0.55 ? 'pulse' : 'triangle';
    } else {
      return hent > 0.6 ? 'fm-pluck' : 'am-bell';
    }
  };
  const pickHarmonyInst = (variant = 0) => {
    // soft-pad は柔らかい画像で harmony に使う
    if (variant === 0) {
      if (hent > 0.5) return 'am-bell';
      // 暗くて柔らかい画像 (low complexity + low skew) → soft-pad
      if (complexity < 0.5 && skew < 0.5) return 'soft-pad';
      return 'sine';
    }
    return skew > 0.5 ? 'triangle' : 'sine';
  };

  // roster 決定
  const roster = [];
  // 必須: bass + lead
  roster.push({ method: 'bass-root', instrument: pickBassInst(), octaveShift: skew < 0.4 ? -2 : -1, gain: 0.35 });
  roster.push({ method: 'phrase-melody', instrument: pickLeadInst(0), octaveShift: vdiff > 0.6 ? 1 : 0, gain: 0.32 });
  // complexity に応じて追加
  if (complexity > 0.3) {
    roster.push({ method: 'chord-pad', instrument: pickHarmonyInst(0), octaveShift: 0, gain: 0.22 });
  }
  if (complexity > 0.6) {
    roster.push({ method: 'phrase-melody', instrument: pickLeadInst(1), octaveShift: vdiff > 0.5 ? 1 : 2, gain: 0.22 });
  }
  if (complexity > 0.8) {
    roster.push({ method: 'chord-pad', instrument: pickHarmonyInst(1), octaveShift: 1, gain: 0.18 });
  }

  // 既存 generators を全削除 (音声も破棄)
  while (gens.length > 0) {
    const g = gens[gens.length - 1];
    if (typeof disposeGenAudio === 'function') {
      try { disposeGenAudio(g); } catch(e) {}
    }
    gens.pop();
  }

  // 新 generators 構築
  const prog = m.progression || 'I-V-vi-IV';
  const tempoHint = m.tempoHint || 1.0;
  const jumpRangeHint = m.jumpRangeHint || 2.5;
  const phraseDensityHint = m.phraseDensityHint || 2.0;
  const chordStability = m.chordStabilityHint || 0.5;
  const bassSolidity = m.bassSolidityHint || 0.5;

  for (const spec of roster) {
    const g = (typeof addGenerator === 'function')
      ? addGenerator(spec.method, spec.instrument)
      : null;
    if (!g) continue;
    g.gain = spec.gain;
    if (g.gainNode) g.gainNode.gain.value = spec.gain;
    g.octaveShift = spec.octaveShift;
    g.progression = prog;
    // method 別パラメータ (deriveMusical のヒントを適用)
    if (g.method === 'phrase-melody') {
      g.density = Math.min(6, Math.max(0.5, phraseDensityHint * 2));
      g.chordDur = Math.min(10, Math.max(1, 6 - tempoHint * 3));
      g.phraseLen = Math.round(Math.min(16, Math.max(4, 4 + phraseDensityHint * 4)));
      g.jumpRange = Math.min(5, Math.max(1, Math.round(jumpRangeHint / 3)));
    } else if (g.method === 'chord-pad') {
      g.chordDur = Math.min(10, Math.max(2, 3 + chordStability * 6));
    } else if (g.method === 'bass-root') {
      g.chordDur = Math.min(10, Math.max(2, 3 + bassSolidity * 6));
      g.bassBeats = Math.round(Math.min(8, Math.max(1, 2 + bassSolidity * 4)));
    }
    g.chordState = null;
  }

  // UI 再描画
  if (typeof window.renderGenList === 'function') {
    window.renderGenList();
  } else if (typeof renderGenList === 'function') {
    renderGenList();
  }
};

console.log('♪ melody.js loaded — phrase/chord/bass methods ready');
