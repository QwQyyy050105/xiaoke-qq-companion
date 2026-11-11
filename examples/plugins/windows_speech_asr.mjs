import {recognizeWindowsSpeech} from '../../src/windows_speech_asr.mjs';

export default {
  apiVersion:1,
  id:'windows-speech-asr',
  capabilities:['asr'],
  setup() { return {asr:recognizeWindowsSpeech}; }
};
