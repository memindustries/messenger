// Tiny synthesized sound effects (no audio files, nothing fetched).
let ctx = null;
let enabled = true;

export function setSoundEnabled(on) {
  enabled = on;
}

export function unlockAudio() {
  if (!ctx) {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (AC) ctx = new AC();
  }
  if (ctx?.state === 'suspended') ctx.resume();
}

function tone(freq, start, dur, { type = 'square', vol = 0.06, slideTo } = {}) {
  const t = ctx.currentTime + start;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(vol, t + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

function play(fn) {
  if (!enabled || !ctx) return;
  try {
    fn();
  } catch { /* audio is optional */ }
}

export const sounds = {
  // Creaky door opening: a buddy signed on.
  doorOpen: () => play(() => {
    tone(180, 0, 0.35, { type: 'sawtooth', vol: 0.03, slideTo: 420 });
    tone(640, 0.3, 0.12, { type: 'triangle', vol: 0.05 });
  }),
  // Door slam: a buddy signed off.
  doorClose: () => play(() => {
    tone(300, 0, 0.12, { type: 'sawtooth', vol: 0.04, slideTo: 90 });
    tone(70, 0.1, 0.18, { type: 'square', vol: 0.06 });
  }),
  imIn: () => play(() => {
    tone(523, 0, 0.1, { type: 'triangle', vol: 0.09 });
    tone(784, 0.11, 0.16, { type: 'triangle', vol: 0.09 });
  }),
  imOut: () => play(() => {
    tone(880, 0, 0.07, { type: 'triangle', vol: 0.05, slideTo: 1200 });
  }),
};
