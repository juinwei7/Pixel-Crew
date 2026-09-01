// whisper.cpp 只吃 wav/flac/mp3/ogg，MediaRecorder 在多數瀏覽器預設輸出的是
// webm/opus 容器；與其在伺服器端加 ffmpeg 做轉檔，改成瀏覽器端用 Web Audio
// decodeAudioData 解回 PCM，再用這裡的純函式重新取樣＋編碼成 16kHz 單聲道 WAV，
// 全程留在本機、不需要新增伺服器端轉檔依賴。
export const VOICE_TARGET_SAMPLE_RATE = 16_000;

export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length <= 1) return channels[0] ?? new Float32Array(0);
  const length = channels[0].length;
  const mono = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (const channel of channels) sum += channel[i];
    mono[i] = sum / channels.length;
  }
  return mono;
}

export function linearResample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples;
  const ratio = fromRate / toRate;
  const outLength = Math.max(1, Math.round(samples.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const sourceIndex = i * ratio;
    const lower = Math.floor(sourceIndex);
    const upper = Math.min(lower + 1, samples.length - 1);
    const fraction = sourceIndex - lower;
    out[i] = samples[lower] + (samples[upper] - samples[lower]) * fraction;
  }
  return out;
}

export function resampleToMono16k(channels: Float32Array[], sourceSampleRate: number): Float32Array {
  return linearResample(mixToMono(channels), sourceSampleRate, VOICE_TARGET_SAMPLE_RATE);
}

export function encodeWavPcm16(samples: Float32Array, sampleRate = VOICE_TARGET_SAMPLE_RATE): ArrayBuffer {
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true); // bits per sample
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

export function encodeWavBlob(samples: Float32Array, sampleRate = VOICE_TARGET_SAMPLE_RATE): Blob {
  return new Blob([encodeWavPcm16(samples, sampleRate)], { type: "audio/wav" });
}

// whisper 對靜音／幾乎沒聲音的錄音不會回傳空字串，而是「幻覺」出一段無關的文字
// （常見的例子是 YouTube 式的「請不吝點讚訂閱」）。伺服器端沒有 VAD，這裡在送出前
// 用簡單的均方根音量擋掉明顯沒講話的錄音，對應 spec §6「沒有偵測到語音」那一列——
// 不送出、不讓幻覺文字混進聊天輸入框。
//
// 實測的原始麥克風音量會因裝置而有很大差異，Windows 的內建麥克風尤其常比 Mac
// 低。瀏覽器已啟用自動增益與降噪，但仍保留一個低門檻擋住純靜音；0.008 比安靜房間
// 的背景音量稍高，又不會把正常但較小聲的 Windows 輸入誤判成沒有錄到。
export const MIN_SPEECH_RMS = 0.008;

export function computeRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sumSquares = 0;
  for (const sample of samples) sumSquares += sample * sample;
  return Math.sqrt(sumSquares / samples.length);
}

export function hasAudibleSpeech(samples: Float32Array, threshold = MIN_SPEECH_RMS): boolean {
  return computeRms(samples) >= threshold;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

// 語音輸入的隱私承諾是「音訊不離開本機」；經 cloudflared/Tailscale 遠端存取轉接站
// 進來的請求，錄音裝置（手機麥克風）本身就不是本機，即便音訊最終仍在這台主機上
// 處理也不成立這個承諾。用網址的 hostname 判斷比對伺服器 Host header 更可靠：遠端
// 存取轉接站會把請求原樣代理進本體，本體看到的 Host 仍像是本機。
const LOCAL_VOICE_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLocalVoiceInputContext(hostname: string): boolean {
  return LOCAL_VOICE_HOSTNAMES.has(hostname);
}
