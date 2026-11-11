import {spawn} from 'node:child_process';
import {join} from 'node:path';

// Windows PowerShell runs the desktop speech engine with a memory stream as its only input.
const script = `
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Speech
$audio=[System.IO.MemoryStream]::new()
try {
  [Console]::OpenStandardInput().CopyTo($audio)
  $audio.Position=0
  $culture=[Globalization.CultureInfo]::GetCultureInfo($env:XIAOKE_ASR_LANGUAGE)
  $engine=[System.Speech.Recognition.SpeechRecognitionEngine]::new($culture)
  $engine.LoadGrammar([System.Speech.Recognition.DictationGrammar]::new())
  $engine.SetInputToWaveStream($audio)
  $parts=@()
  while ($true) {
    try { $line=$engine.Recognize() }
    catch [System.InvalidOperationException] { if ($engine.AudioState -eq 'Stopped') { break }; throw }
    if (!$line) { break }
    if ($line.Text) { $parts+=$line.Text }
  }
  [Console]::Write(($parts -join ' '))
} finally {
  if ($engine) { $engine.Dispose() }
  $audio.Dispose()
}`;

function wave(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export async function recognizeWindowsSpeech({buffer, mime, signal}) {
  if (process.platform !== 'win32' || !['audio/wav','audio/silk'].includes(mime)) return {status:'unsupported'};
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);
  signal.throwIfAborted();
  if (mime === 'audio/silk') {
    const {decode, getDuration} = await import('silk-wasm');
    const milliseconds = getDuration(buffer);
    if (!(milliseconds > 0 && milliseconds <= 180000)) throw Error('voice_duration_limit');
    const {data} = await decode(buffer, 16000);
    if (!data?.length || data.length > 180 * 32000) throw Error('voice_invalid_silk');
    buffer = wave(data);
  }
  signal.throwIfAborted();
  const executable = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const text = await new Promise((resolve, reject) => {
    const env = {SystemRoot:process.env.SystemRoot, TEMP:process.env.TEMP, TMP:process.env.TMP,
      XIAOKE_ASR_LANGUAGE:process.env.XIAOKE_ASR_LANGUAGE || 'zh-CN'};
    const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      env, signal, windowsHide:true, stdio:['pipe', 'pipe', 'ignore']
    });
    const chunks = [];
    let size = 0;
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > 16000) child.kill();
      else chunks.push(chunk);
    });
    child.on('error', () => reject(Error('windows_asr_unavailable')));
    child.stdin.on('error', () => {}); // The exit event reports decoder or recognizer failure.
    child.on('close', code => code === 0 && size <= 16000 ? resolve(Buffer.concat(chunks).toString('utf8').trim()) : reject(Error('windows_asr_failed')));
    child.stdin.end(buffer);
  });
  return text ? {status:'ok', text} : {status:'no_speech'};
}
