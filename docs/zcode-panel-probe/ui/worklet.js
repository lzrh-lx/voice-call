// 探针用的空 worklet：只验证 addModule 能否在面板里加载
class ProbeProcessor extends AudioWorkletProcessor {
  process() { return true; }
}
registerProcessor('probe-proc', ProbeProcessor);
