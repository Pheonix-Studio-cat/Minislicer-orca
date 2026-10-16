package main

import (
	"archive/zip"
	"bytes"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// maxUpload caps one sliced file. A .gcode.3mf for a full A1/X1 plate is usually well under 100 MB.
const maxUpload = 512 << 20

type server struct {
	web       fs.FS
	token     string
	printsDir string
	port      int
	open      func(string) error // opens a URL with the OS handler
	connect   func() *bool       // reports whether Bambu Connect is installed; nil when unknown
	quit      chan struct{}
}

func newToken() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// loadToken keeps the pairing token across restarts, so a paired phone stays paired.
func loadToken(dir string) (string, error) {
	path := filepath.Join(dir, "token")
	if b, err := os.ReadFile(path); err == nil {
		if t := strings.TrimSpace(string(b)); regexp.MustCompile(`^[0-9a-f]{32}$`).MatchString(t) {
			return t, nil
		}
	}
	t, err := newToken()
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	return t, os.WriteFile(path, []byte(t+"\n"), 0o600)
}

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/status", s.status)
	mux.HandleFunc("/api/pairing", s.loopbackOnly(s.pairing))
	mux.HandleFunc("/api/quit", s.loopbackOnly(s.quitHandler))
	mux.HandleFunc("/api/print", s.print)
	mux.Handle("/", s.static())
	return securityHeaders(mux)
}

// hostAllowed rejects requests addressed to a domain name. The runner is reached by IP (from the
// QR code) or as localhost, so any other Host means a DNS-rebinding page is trying to talk to it.
func hostAllowed(host string) bool {
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	host = strings.Trim(host, "[]")
	return host == "localhost" || net.ParseIP(host) != nil
}

func securityHeaders(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !hostAllowed(r.Host) {
			http.Error(w, "use the address shown by the runner", http.StatusMisdirectedRequest)
			return
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "DENY")
		h.ServeHTTP(w, r)
	})
}

func (s *server) static() http.Handler {
	files := http.FileServer(http.FS(s.web))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Cache-Control", "no-cache")
		files.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func (s *server) authorized(r *http.Request) bool {
	got := r.Header.Get("X-Runner-Token")
	return len(got) == len(s.token) && subtle.ConstantTimeCompare([]byte(got), []byte(s.token)) == 1
}

func isLoopback(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func (s *server) loopbackOnly(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !isLoopback(r) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "only available on this computer"})
			return
		}
		h(w, r)
	}
}

func (s *server) status(w http.ResponseWriter, r *http.Request) {
	host, _ := os.Hostname()
	resp := map[string]any{
		"app":     "minislicer-runner",
		"version": version,
		"os":      goos,
		"paired":  s.authorized(r),
	}
	// Only a paired client learns about the computer.
	if s.authorized(r) {
		resp["host"] = host
		if c := s.connect(); c != nil {
			resp["bambuConnect"] = *c
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

// lanURLs lists the addresses a phone on the same network can reach the runner at.
func lanURLs(port int, token string) []string {
	urls := []string{} // never nil: the pairing page expects a JSON array
	ifaces, _ := net.Interfaces()
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok || ipn.IP.To4() == nil || !ipn.IP.IsPrivate() {
				continue
			}
			urls = append(urls, fmt.Sprintf("http://%s:%d/?token=%s", ipn.IP.String(), port, token))
		}
	}
	return urls
}

func (s *server) pairing(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{
		"token":     s.token,
		"urls":      lanURLs(s.port, s.token),
		"printsDir": s.printsDir,
	})
}

func (s *server) quitHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST only"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	select {
	case s.quit <- struct{}{}:
	default:
	}
}

var unsafeName = regexp.MustCompile(`[^A-Za-z0-9._ -]+`)

// cleanName turns the client's suggested file name into a safe base name ending in .gcode.3mf.
func cleanName(name string) string {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.TrimSuffix(strings.TrimSuffix(name, ".3mf"), ".gcode")
	name = strings.Trim(unsafeName.ReplaceAllString(name, "_"), " ._")
	if len(name) > 80 {
		name = name[:80]
	}
	if name == "" {
		name = "print"
	}
	return name + ".gcode.3mf"
}

// checkSliced3mf accepts only a ZIP that carries sliced G-code, which is what Bambu Connect imports.
func checkSliced3mf(b []byte) error {
	zr, err := zip.NewReader(bytes.NewReader(b), int64(len(b)))
	if err != nil {
		return errors.New("not a 3MF (ZIP) file")
	}
	for _, f := range zr.File {
		if strings.HasPrefix(f.Name, "Metadata/plate_") && strings.HasSuffix(f.Name, ".gcode") {
			return nil
		}
	}
	return errors.New("the 3MF has no sliced G-code (Metadata/plate_N.gcode)")
}

// encodeURIComponent matches JavaScript's, which is what the Bambu Connect URL scheme expects.
func encodeURIComponent(s string) string {
	var b strings.Builder
	for _, c := range []byte(s) {
		if c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || strings.IndexByte("-_.!~*'()", c) >= 0 {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

// bambuConnectURL builds the import link documented by Bambu Lab:
// bambu-connect://import-file?path=<abs path>&name=<display name>&version=1.0.0
func bambuConnectURL(path, name string) string {
	return "bambu-connect://import-file?path=" + encodeURIComponent(path) + "&name=" + encodeURIComponent(name) + "&version=1.0.0"
}

func (s *server) print(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]string{"error": "POST only"})
		return
	}
	if !s.authorized(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "not paired - scan the QR code the runner shows on your computer"})
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxUpload))
	if err != nil {
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "file too large or upload interrupted"})
		return
	}
	if err := checkSliced3mf(body); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if err := os.MkdirAll(s.printsDir, 0o755); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "cannot create the prints folder"})
		return
	}
	file := cleanName(r.URL.Query().Get("name"))
	display := strings.TrimSuffix(file, ".gcode.3mf")
	file = time.Now().Format("20060102-150405") + "_" + file
	path, err := filepath.Abs(filepath.Join(s.printsDir, file))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if err := os.WriteFile(path, body, 0o644); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "cannot save the file"})
		return
	}
	link := bambuConnectURL(path, display)
	log.Printf("received %s (%d KB), opening Bambu Connect", file, len(body)/1024)
	if err := s.open(link); err != nil {
		log.Printf("could not open Bambu Connect: %v", err)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "saved, but Bambu Connect did not open - is it installed?", "path": path})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "path": path})
}

func init() {
	// Some systems lack these in their MIME tables.
	_ = mime.AddExtensionType(".mjs", "text/javascript")
	_ = mime.AddExtensionType(".js", "text/javascript")
	_ = mime.AddExtensionType(".webmanifest", "application/manifest+json")
	_ = mime.AddExtensionType(".svg", "image/svg+xml")
}
