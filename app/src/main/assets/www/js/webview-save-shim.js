/* Routes download() calls to the native Android saver when running inside the app's WebView. */
(function () {
    var orig = window.download;
    if (typeof orig !== 'function') return;
    window.download = function (data, name, mime) {
        if (window.NativeSaver) {
            try {
                name = name || 'download';
                if (typeof data === 'string' && data.indexOf('data:') === 0) {
                    NativeSaver.saveDataUrl(data, name, mime || '');
                    return true;
                }
                if (typeof Blob !== 'undefined' && data instanceof Blob) {
                    var r = new FileReader();
                    r.onload = function () { NativeSaver.saveDataUrl(String(r.result), name, mime || data.type || ''); };
                    r.readAsDataURL(data);
                    return true;
                }
                if (typeof data === 'string') {
                    NativeSaver.saveText(data, name, mime || 'text/plain');
                    return true;
                }
            } catch (e) { console.error('NativeSaver failed', e); }
        }
        return orig.apply(this, arguments);
    };
})();
