// Minislicer Runner: serves the mobile web slicer on the local network and hands sliced
// .gcode.3mf files to Bambu Connect on this computer.
//
//	minislicer-runner [-port 8787] [-prints DIR] [-no-browser]
//
// On start it opens a pairing page in the browser with a QR code. Scanning it on a phone opens
// the slicer with a pairing token; only requests carrying that token may start prints.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"minislicer/mobile"
)

var (
	version = "0.1.0"
	goos    = runtime.GOOS
)

func main() {
	home, _ := os.UserHomeDir()
	cfgDir, err := os.UserConfigDir()
	if err != nil {
		cfgDir = home
	}
	port := flag.Int("port", 8787, "port to listen on")
	prints := flag.String("prints", filepath.Join(home, "Minislicer Prints"), "folder for received print files")
	noBrowser := flag.Bool("no-browser", false, "do not open the pairing page")
	flag.Parse()

	pairURL := fmt.Sprintf("http://127.0.0.1:%d/pair.html", *port)
	ln, err := net.Listen("tcp", fmt.Sprintf(":%d", *port))
	if err != nil {
		// Most likely the runner is already running (e.g. started twice): show its pairing page.
		log.Printf("port %d is busy (%v); opening the running instance", *port, err)
		_ = openURL(pairURL)
		return
	}

	token, err := loadToken(filepath.Join(cfgDir, "minislicer-runner"))
	if err != nil {
		log.Fatalf("cannot create the pairing token: %v", err)
	}
	web, err := fs.Sub(mobile.Web, "web")
	if err != nil {
		log.Fatal(err)
	}
	s := &server{
		web: web, token: token, printsDir: *prints, port: *port,
		open: openURL, connect: bambuConnectInstalled, quit: make(chan struct{}, 1),
	}
	srv := &http.Server{Handler: s.routes(), ReadHeaderTimeout: 10 * time.Second}

	fmt.Printf("Minislicer Runner %s\n", version)
	fmt.Printf("Prints are saved to: %s\n", *prints)
	fmt.Println("Open one of these on your phone or tablet (same Wi-Fi):")
	for _, u := range lanURLs(*port, token) {
		fmt.Println("  " + u)
	}
	fmt.Printf("Pairing page with QR code: %s\n", pairURL)
	fmt.Println("Close this window or press Ctrl+C to stop.")

	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
	}()
	if !*noBrowser {
		_ = openURL(pairURL)
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	select {
	case <-sig:
	case <-s.quit:
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
	fmt.Println("Runner stopped.")
}
