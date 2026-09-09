// panel/mic.js — halaman kecil satu tujuan: memunculkan prompt izin mikrofon.
// Offscreen document & side panel tidak bisa memunculkan prompt (getUserMedia
// gagal "Permission dismissed"); hanya halaman extension di window/tab
// sungguhan yang bisa. Izin tersimpan per origin extension, jadi setelah ini
// offscreen dapat mic tanpa prompt. Dibuka service worker (askMicPermission);
// menutup DIRI SENDIRI, bukan lewat SW — SW bisa idle-restart selama user
// membaca prompt, dan id jendela yang cuma hidup di memori SW ikut hilang.
const msg = document.getElementById('msg');
navigator.mediaDevices.getUserMedia({ audio: true }).then(
  (s) => { s.getTracks().forEach((t) => t.stop()); return true; }, // cuma butuh izinnya
  () => false,
).then((granted) => {
  msg.textContent = granted
    ? 'Mikrofon diizinkan ✓ — jendela ini menutup sendiri.'
    : 'Izin mikrofon ditolak. Rekaman tetap jalan tanpa suara mikrofon. '
      + 'Ulangi dari Settings → "Izinkan mikrofon", atau cek chrome://settings/content/microphone.';
  chrome.runtime.sendMessage({ type: 'mic-permission', granted }).catch(() => {});
  // Ditolak → beri waktu baca. windows.remove, bukan window.close(): halaman
  // yang dibuka extension bukan "dibuka oleh script" di mata Chrome.
  setTimeout(() => chrome.windows.getCurrent().then((w) => chrome.windows.remove(w.id)).catch(() => {}),
    granted ? 500 : 4000);
});
