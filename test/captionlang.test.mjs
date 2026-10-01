import { test } from 'node:test';
import assert from 'node:assert/strict';

// Label asli dari DOM Meet (dump 2026-10-01, UI Inggris). Daftar inilah yang
// membuat pencocokan tidak sepele: "Javanese (Indonesia)" mengandung kata
// Indonesia, dan English punya lima varian.
const LABELS = ['English', 'English (Australia)', 'English (India)',
  'English (Philippines)', 'English (UK)', 'Indonesian (Indonesia)', 'Javanese (Indonesia)'];

// langOption() membaca DOM; di sini document dipalsukan seperlunya supaya
// aturan "label terpendek menang" ikut teruji, bukan cuma regexnya.
globalThis.document = {
  querySelectorAll: () => LABELS.map((t) => ({ textContent: `  ${t}  ` })),
};
await import('../content/selectors.js'); // classic script: set globalThis.MeetSelectors
const { langOption, LANG_PATTERN } = globalThis.MeetSelectors;

const pick = (lang) => langOption(LANG_PATTERN[lang])?.textContent.trim();

test('Indonesia tidak tertukar dengan Javanese (Indonesia)', () => {
  assert.equal(pick('id'), 'Indonesian (Indonesia)');
  assert.ok(!LANG_PATTERN.id.test('Javanese (Indonesia)'));
});

test('English memilih yang polos, bukan varian negara', () => {
  assert.equal(pick('en'), 'English');
});

test('label versi UI Indonesia ikut cocok', () => {
  assert.ok(LANG_PATTERN.id.test('Bahasa Indonesia'));
  assert.ok(LANG_PATTERN.id.test('Indonesia (Indonesia)'));
  assert.ok(LANG_PATTERN.en.test('Inggris (Amerika Serikat)'));
  assert.ok(!LANG_PATTERN.en.test('Indonesia (Indonesia)'));
});

test('tanpa opsi yang cocok mengembalikan null, bukan opsi sembarang', () => {
  assert.equal(langOption(/^klingon\b/i), null);
});
