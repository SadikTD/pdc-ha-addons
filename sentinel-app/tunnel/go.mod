module sentinelapp/tunnel

go 1.26.0

require (
	github.com/quic-go/quic-go v0.63.0
	sentinel v0.0.0
)

require (
	github.com/gorilla/websocket v1.5.3 // indirect
	github.com/quic-go/qpack v0.6.0 // indirect
	golang.org/x/crypto v0.57.0 // indirect
	golang.org/x/net v0.58.0 // indirect
	golang.org/x/sys v0.48.0 // indirect
	golang.org/x/text v0.42.0 // indirect
)

replace sentinel => ../../sentinel/backend
