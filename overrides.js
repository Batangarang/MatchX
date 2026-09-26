// Manual text overrides set from admin.html (stored in overrides.json).
// An override shows only while it is switched on AND either "hold" is set or the
// underlying AI text has not been regenerated since the override was written.
(function () {
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function active(ov, key, generatedAt) {
    const t = ov && ov.texts && ov.texts[key];
    if (!t || !t.enabled || !t.text) return null;
    if (!t.hold && t.base !== generatedAt) return null; // content refreshed since the edit — drop the override
    return t;
  }

  window.MatchXOverrides = {
    esc,
    load() {
      return fetch('overrides.json?t=' + Date.now())
        .then(r => (r.ok ? r.json() : {}))
        .catch(() => ({}));
    },
    // Plain (unescaped) override text, or null
    plain(ov, key, generatedAt) {
      const t = active(ov, key, generatedAt);
      return t ? t.text : null;
    },
    // HTML-safe override text with line breaks, or null
    html(ov, key, generatedAt) {
      const t = active(ov, key, generatedAt);
      return t ? esc(t.text).replace(/\n/g, '<br>') : null;
    },
  };
})();
