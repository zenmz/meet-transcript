// content/captionhide.js — tombol kecil berikon extension di halaman Meet untuk
// MENYEMBUNYIKAN caption dari layar tanpa mematikan CC: container caption cuma
// diberi `visibility: hidden`, DOM-nya tetap hidup dan terus bermutasi, jadi
// observer di captions.js tetap mengisi transkrip. (display:none dihindari —
// Meet mengukur container itu untuk tata letak.) Status disimpan di storage
// (`captionsHidden`) supaya berlaku lintas rapat, bukan cuma satu halaman.
(() => {
  const S = globalThis.MeetSelectors;
  const KEY = 'captionsHidden';

  const style = document.createElement('style');
  style.textContent = S.CAPTION_REGION.join(', ') + ' { visibility: hidden !important; }';

  const btn = document.createElement('button');
  btn.type = 'button';
  Object.assign(btn.style, {
    position: 'fixed', right: '16px', bottom: '96px', zIndex: '2147483647',
    width: '36px', height: '36px', padding: '6px', border: '0', borderRadius: '50%',
    background: 'rgba(32,33,36,.85)', cursor: 'pointer', display: 'none',
  });
  const img = document.createElement('img');
  img.src = chrome.runtime.getURL('icons/icon48.png'); // butuh web_accessible_resources
  img.alt = 'Meet Transcript';
  Object.assign(img.style, { width: '100%', height: '100%', display: 'block' });
  btn.append(img);

  let hidden = false;
  function apply(on) {
    hidden = !!on;
    if (hidden) document.documentElement.append(style); else style.remove();
    btn.title = hidden
      ? 'Tampilkan caption'
      : 'Sembunyikan caption (CC tetap nyala, transkrip tetap jalan)';
    img.style.opacity = hidden ? '0.4' : '1';
  }
  btn.addEventListener('click', () => {
    apply(!hidden);
    chrome.storage.local.set({ [KEY]: hidden }).catch(() => {});
  });
  document.documentElement.append(btn);
  chrome.storage.local.get(KEY).then((d) => apply(d[KEY]));

  // Hanya tampil di dalam call — di landing/lobby tak ada caption. Script
  // yatim (extension di-reload) berhenti sendiri, seperti captions.js.
  const timer = setInterval(() => {
    if (!chrome.runtime?.id) { clearInterval(timer); btn.remove(); style.remove(); return; }
    btn.style.display = S.inCall() ? 'block' : 'none';
  }, 2000);
})();
