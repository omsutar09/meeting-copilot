// Converts Float32 audio (already at the AudioContext's 16 kHz rate) into
// 16-bit PCM and posts ~100 ms chunks to the main thread.
class PcmWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(1600);
    this.len = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input.length) return true;
    const ch0 = input[0];
    const ch1 = input[1];
    for (let i = 0; i < ch0.length; i++) {
      // Down-mix stereo to mono.
      let s = ch1 ? (ch0[i] + ch1[i]) / 2 : ch0[i];
      s = Math.max(-1, Math.min(1, s));
      this.buf[this.len++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this.len === this.buf.length) {
        let peak = 0;
        for (let j = 0; j < this.len; j++) peak = Math.max(peak, Math.abs(this.buf[j]));
        const out = this.buf.slice(0, this.len);
        this.port.postMessage({ pcm: out.buffer, level: peak / 0x8000 }, [out.buffer]);
        this.len = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-worklet', PcmWorklet);
