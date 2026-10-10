// The in-browser models, in their own file. background.js loads it only
// when a memory needs an embedding or the user picks the in-browser
// planner; the sidebar loads it for Whisper at the first talk press. web-ext lint skips it with ort/: transformers.js and ONNX
// Runtime evaluate strings, and the rest of foxmate does not.
export { transformers } from "foxmind/browser";
export { whisper } from "foxvoice/browser";
