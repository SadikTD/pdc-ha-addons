//go:build tools

// Keeps gomobile's bind package in go.mod for `gomobile bind`.
package tunnel

import _ "golang.org/x/mobile/bind"
