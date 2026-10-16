// Package mobile embeds the web slicer so the runner can serve it from a single binary.
package mobile

import "embed"

//go:embed web
var Web embed.FS
