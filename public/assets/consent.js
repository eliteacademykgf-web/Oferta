// Уведомление о сборе данных и cookie: показывается один раз, выбор помнится в браузере клиента.
(function () {
  var KEY = 'elite_offer_consent';
  try { if (localStorage.getItem(KEY)) return; } catch (e) { /* без хранилища показываем каждый раз */ }

  var css = document.createElement('style');
  css.textContent =
    '.cc{position:fixed;left:12px;right:12px;bottom:12px;z-index:9999;max-width:760px;margin:0 auto;' +
    'background:#fff;color:#1E293B;border:1px solid rgba(6,64,102,.15);border-radius:16px;' +
    'box-shadow:0 14px 40px -12px rgba(6,64,102,.35);padding:16px 18px;display:flex;gap:16px;align-items:center;' +
    'font:14px/1.45 "DM Sans",system-ui,sans-serif}' +
    '.cc p{margin:0;flex:1}.cc a{color:#1A5E90}' +
    '.cc button{flex:none;border:0;border-radius:999px;background:#064066;color:#fff;font:600 14px "DM Sans",system-ui,sans-serif;' +
    'padding:11px 22px;cursor:pointer}' +
    '@media(max-width:560px){.cc{flex-direction:column;align-items:stretch;text-align:left}}';
  document.head.appendChild(css);

  var box = document.createElement('div');
  box.className = 'cc';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Согласие на обработку данных');
  box.innerHTML =
    '<p>Продолжая пользоваться сайтом, вы соглашаетесь, что мы собираем пользовательские данные: ' +
    'файлы cookie, IP-адрес, сведения об устройстве и браузере, время ваших действий в документе (просмотр и ' +
    'подтверждение страниц, подпись). Эти данные нужны для оформления документа и подтверждения вашего согласия с ним.</p>' +
    '<button type="button">Согласен(на)</button>';
  box.querySelector('button').addEventListener('click', function () {
    try { localStorage.setItem(KEY, new Date().toISOString()); } catch (e) { /* не страшно */ }
    box.remove();
  });
  function mount() { document.body.appendChild(box); }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);
})();
