package main

import (
	"os/exec"
	"runtime"
	"strings"
)

// openURL hands a URL to the operating system, which routes bambu-connect:// links to
// Bambu Connect and http:// links to the default browser. The URL is passed as a single
// argument, never through a shell.
func openURL(u string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", u)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", u)
	default:
		cmd = exec.Command("xdg-open", u)
	}
	return cmd.Start()
}

// bambuConnectInstalled reports whether something handles bambu-connect:// links, or nil
// when the platform gives no reliable answer.
func bambuConnectInstalled() *bool {
	yes, no := true, false
	switch runtime.GOOS {
	case "darwin":
		if exec.Command("open", "-Ra", "Bambu Connect").Run() == nil {
			return &yes
		}
		return &no
	case "windows":
		for _, key := range []string{`HKCU\Software\Classes\bambu-connect`, `HKCR\bambu-connect`} {
			if exec.Command("reg", "query", key).Run() == nil {
				return &yes
			}
		}
		return &no
	default:
		out, err := exec.Command("xdg-mime", "query", "default", "x-scheme-handler/bambu-connect").Output()
		if err != nil {
			return nil
		}
		found := strings.TrimSpace(string(out)) != ""
		return &found
	}
}
