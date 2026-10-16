package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

const testToken = "0123456789abcdef0123456789abcdef"

func testServer(t *testing.T) (*server, *[]string) {
	t.Helper()
	opened := []string{}
	s := &server{
		web:       fstest.MapFS{"index.html": {Data: []byte("<!doctype html>slicer")}},
		token:     testToken,
		printsDir: t.TempDir(),
		port:      8787,
		open:      func(u string) error { opened = append(opened, u); return nil },
		connect:   func() *bool { v := true; return &v },
		quit:      make(chan struct{}, 1),
	}
	return s, &opened
}

func sliced3mf(t *testing.T, files ...string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, f := range files {
		w, err := zw.Create(f)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte("; test\n"))
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func do(s *server, method, target, remote, host string, body []byte, token string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, target, bytes.NewReader(body))
	r.RemoteAddr = remote
	r.Host = host
	if token != "" {
		r.Header.Set("X-Runner-Token", token)
	}
	w := httptest.NewRecorder()
	s.routes().ServeHTTP(w, r)
	return w
}

func TestPrintSavesFileAndOpensBambuConnect(t *testing.T) {
	s, opened := testServer(t)
	body := sliced3mf(t, "Metadata/plate_1.gcode", "Metadata/slice_info.config")
	w := do(s, "POST", "/api/print?name="+url.QueryEscape("Benchy & Co_0.20mm_PLA.gcode.3mf"), "192.168.1.20:5000", "192.168.1.10:8787", body, testToken)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body)
	}
	var resp struct {
		OK   bool   `json:"ok"`
		Path string `json:"path"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil || !resp.OK {
		t.Fatalf("bad response %s", w.Body)
	}
	if filepath.Dir(resp.Path) != s.printsDir {
		t.Fatalf("saved outside the prints folder: %s", resp.Path)
	}
	if !strings.HasSuffix(resp.Path, "_Benchy _ Co_0.20mm_PLA.gcode.3mf") {
		t.Fatalf("unexpected file name %s", resp.Path)
	}
	got, err := os.ReadFile(resp.Path)
	if err != nil || !bytes.Equal(got, body) {
		t.Fatalf("saved file differs: %v", err)
	}
	if len(*opened) != 1 {
		t.Fatalf("expected one opened URL, got %v", *opened)
	}
	u, err := url.Parse((*opened)[0])
	if err != nil || u.Scheme != "bambu-connect" || u.Host != "import-file" {
		t.Fatalf("not a bambu-connect import link: %s", (*opened)[0])
	}
	q := u.Query()
	if q.Get("path") != resp.Path || q.Get("name") != "Benchy _ Co_0.20mm_PLA" || q.Get("version") != "1.0.0" {
		t.Fatalf("wrong link parameters: %v", q)
	}
	// The link must not carry raw separators from the path or name.
	if strings.Contains(strings.SplitN((*opened)[0], "?", 2)[1], " ") || strings.Count((*opened)[0], "&") != 2 {
		t.Fatalf("link is not encoded: %s", (*opened)[0])
	}
}

func TestPrintNeedsToken(t *testing.T) {
	s, opened := testServer(t)
	body := sliced3mf(t, "Metadata/plate_1.gcode")
	for _, tok := range []string{"", "wrong", strings.ToUpper(testToken)} {
		if w := do(s, "POST", "/api/print?name=a", "192.168.1.20:5000", "192.168.1.10:8787", body, tok); w.Code != http.StatusUnauthorized {
			t.Fatalf("token %q: status %d", tok, w.Code)
		}
	}
	if len(*opened) != 0 {
		t.Fatal("opened Bambu Connect without a valid token")
	}
}

func TestPrintRejectsFilesThatAreNotSliced(t *testing.T) {
	s, opened := testServer(t)
	cases := map[string][]byte{
		"plain text":    []byte("hello"),
		"unsliced 3mf":  sliced3mf(t, "3D/3dmodel.model"),
		"empty archive": sliced3mf(t),
	}
	for name, body := range cases {
		if w := do(s, "POST", "/api/print?name=a", "192.168.1.20:5000", "192.168.1.10:8787", body, testToken); w.Code != http.StatusBadRequest {
			t.Fatalf("%s: status %d", name, w.Code)
		}
	}
	entries, _ := os.ReadDir(s.printsDir)
	if len(entries) != 0 || len(*opened) != 0 {
		t.Fatal("a rejected upload left a file or opened Bambu Connect")
	}
}

func TestPairingAndQuitOnlyFromThisComputer(t *testing.T) {
	s, _ := testServer(t)
	if w := do(s, "GET", "/api/pairing", "192.168.1.20:5000", "192.168.1.10:8787", nil, ""); w.Code != http.StatusForbidden {
		t.Fatalf("pairing from the LAN: status %d", w.Code)
	}
	if w := do(s, "POST", "/api/quit", "192.168.1.20:5000", "192.168.1.10:8787", nil, testToken); w.Code != http.StatusForbidden {
		t.Fatalf("quit from the LAN: status %d", w.Code)
	}
	w := do(s, "GET", "/api/pairing", "127.0.0.1:5000", "127.0.0.1:8787", nil, "")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), testToken) {
		t.Fatalf("pairing from loopback: %d %s", w.Code, w.Body)
	}
	// Even on a machine without a LAN address the page gets an array, not null.
	var p struct {
		URLs []string `json:"urls"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &p); err != nil || p.URLs == nil || strings.Contains(w.Body.String(), `"urls":null`) {
		t.Fatalf("urls must be a JSON array: %s", w.Body)
	}
}

func TestDomainHostsAreRejected(t *testing.T) {
	s, _ := testServer(t)
	// A DNS-rebinding page reaches 127.0.0.1 under its own domain name.
	if w := do(s, "GET", "/api/pairing", "127.0.0.1:5000", "evil.example:8787", nil, ""); w.Code != http.StatusMisdirectedRequest {
		t.Fatalf("status %d", w.Code)
	}
	for _, h := range []string{"localhost:8787", "127.0.0.1:8787", "[::1]:8787", "192.168.1.10:8787"} {
		if !hostAllowed(h) {
			t.Fatalf("%s should be allowed", h)
		}
	}
}

func TestStatusRevealsHostOnlyWhenPaired(t *testing.T) {
	s, _ := testServer(t)
	var anon, paired map[string]any
	_ = json.Unmarshal(do(s, "GET", "/api/status", "192.168.1.20:5000", "192.168.1.10:8787", nil, "").Body.Bytes(), &anon)
	_ = json.Unmarshal(do(s, "GET", "/api/status", "192.168.1.20:5000", "192.168.1.10:8787", nil, testToken).Body.Bytes(), &paired)
	if anon["app"] != "minislicer-runner" || anon["paired"] != false || anon["host"] != nil {
		t.Fatalf("anonymous status: %v", anon)
	}
	if paired["paired"] != true || paired["host"] == nil || paired["bambuConnect"] != true {
		t.Fatalf("paired status: %v", paired)
	}
}

func TestStaticFilesServed(t *testing.T) {
	s, _ := testServer(t)
	w := do(s, "GET", "/", "192.168.1.20:5000", "192.168.1.10:8787", nil, "")
	if w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "slicer") {
		t.Fatalf("index: %d", w.Code)
	}
	if w := do(s, "PUT", "/index.html", "192.168.1.20:5000", "192.168.1.10:8787", nil, ""); w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("PUT: %d", w.Code)
	}
}

func TestCleanName(t *testing.T) {
	cases := map[string]string{
		"../../etc/passwd":       "passwd.gcode.3mf",
		`..\..\Windows\evil.bat`: "evil.bat.gcode.3mf",
		"cube.gcode.3mf":         "cube.gcode.3mf",
		"":                       "print.gcode.3mf",
		"...":                    "print.gcode.3mf",
		"Würfel: 1/2":            "2.gcode.3mf",
	}
	for in, want := range cases {
		if got := cleanName(in); got != want {
			t.Errorf("cleanName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestEncodeURIComponentMatchesJavaScript(t *testing.T) {
	// Expected values from JavaScript's encodeURIComponent.
	cases := map[string]string{
		"/tmp/cube.gcode.3mf":                  "%2Ftmp%2Fcube.gcode.3mf",
		`C:\Users\Ana\Minislicer Prints\a.3mf`: "C%3A%5CUsers%5CAna%5CMinislicer%20Prints%5Ca.3mf",
		"a&b=c+d?e#f":                          "a%26b%3Dc%2Bd%3Fe%23f",
		"Würfel":                               "W%C3%BCrfel",
		"-_.!~*'()":                            "-_.!~*'()",
	}
	for in, want := range cases {
		if got := encodeURIComponent(in); got != want {
			t.Errorf("encodeURIComponent(%q) = %q, want %q", in, got, want)
		}
	}
	if got := bambuConnectURL("/tmp/cube.gcode.3mf", "Cube"); got != "bambu-connect://import-file?path=%2Ftmp%2Fcube.gcode.3mf&name=Cube&version=1.0.0" {
		t.Errorf("link differs from Bambu Lab's documented example: %s", got)
	}
}

func TestTokenPersists(t *testing.T) {
	dir := t.TempDir()
	a, err := loadToken(dir)
	if err != nil {
		t.Fatal(err)
	}
	b, err := loadToken(dir)
	if err != nil || a != b || len(a) != 32 {
		t.Fatalf("token not kept: %q %q %v", a, b, err)
	}
}
