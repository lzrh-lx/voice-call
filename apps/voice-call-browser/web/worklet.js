// 麦克风重采样 AudioWorklet：任意采样率 → 16kHz 单声道 Int16，按 100ms（1600 样本）分帧
class PcmResampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;   // worklet 全局 sampleRate = 上下文采样率
    this.acc = 0;
    this.pos = 0;
    this.buf = [];
    this.muted = false;
    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'mute') this.muted = !!e.data.on;
    };
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i];
      if (++this.pos >= this.ratio) {
        this.buf.push(this.acc / this.pos); // 简单均值低通，兼顾抗混叠
        this.pos = 0;
        this.acc = 0;
      }
    }
    while (this.buf.length >= 1600) {
      const frame = this.buf.splice(0, 1600);
      const out = new Int16Array(1600);
      for (let i = 0; i < 1600; i++) {
        const v = Math.max(-1, Math.min(1, frame[i]));
        out[i] = v < 0 ? v * 32768 : v * 32767;
      }
      if (!this.muted) this.port.postMessage(out, [out.buffer]);
    }
    return true;
  }
}
registerProcessor('pcm-resampler', PcmResampler);
