package main

import (
	"io/fs"
	"strings"
	"testing"

	"minislicer/mobile"
)

// The runner serves the web app to other devices, so the embedded files must carry the
// licence notices and the AGPL source offer.
func TestEmbeddedLicenceNotices(t *testing.T) {
	notices, err := fs.ReadFile(mobile.Web, "web/THIRD-PARTY-NOTICES.txt")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{sourceURL, "three.js", "Boost Software License", "Tom Wu", "Kazuhiko Arase", "The Go Authors", "resources/images"} {
		if !strings.Contains(string(notices), want) {
			t.Errorf("THIRD-PARTY-NOTICES.txt lacks %q", want)
		}
	}
	for _, f := range []string{"three.js-MIT.txt", "clipper-lib-BSL-1.0.txt", "clipper-lib-JSBN.txt", "qrcode-generator-MIT.txt"} {
		if _, err := fs.Stat(mobile.Web, "web/vendor/LICENSES/"+f); err != nil {
			t.Errorf("missing licence %s", f)
		}
	}
	for _, page := range []string{"web/index.html", "web/pair.html"} {
		b, err := fs.ReadFile(mobile.Web, page)
		if err != nil || !strings.Contains(string(b), sourceURL) || !strings.Contains(string(b), "THIRD-PARTY-NOTICES.txt") {
			t.Errorf("%s must link the source code and the notices", page)
		}
	}
}
