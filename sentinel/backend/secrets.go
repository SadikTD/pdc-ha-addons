package main

import (
	"encoding/json"
	"os"
	"sync"
)

// Secrets are credentials the settings API never returns: the WhatsApp bridge token and
// the Google Drive OAuth client and tokens. Stored next to sentinel.json (0600).
type Secrets struct {
	WhatsAppToken     string `json:"whatsapp_token,omitempty"`
	DriveClientID     string `json:"drive_client_id,omitempty"`
	DriveClientSecret string `json:"drive_client_secret,omitempty"`
	DriveRefreshToken string `json:"drive_refresh_token,omitempty"`
	DriveAccount      string `json:"drive_account,omitempty"`
	DriveFolderID     string `json:"drive_folder_id,omitempty"`
	// Firebase (push notifications to the Sentinel app): service account key and the
	// app's public config.
	FirebaseAccount string `json:"firebase_account,omitempty"`
	FirebaseClient  string `json:"firebase_client,omitempty"`
}

type SecretStore struct {
	mu   sync.Mutex
	path string
	s    Secrets
}

func loadSecrets(path string) *SecretStore {
	st := &SecretStore{path: path}
	if data, err := os.ReadFile(path); err == nil {
		if err := json.Unmarshal(data, &st.s); err != nil {
			logf("secrets: %s is unreadable (%v); starting without saved credentials", path, err)
		}
	}
	return st
}

func (st *SecretStore) Get() Secrets {
	st.mu.Lock()
	defer st.mu.Unlock()
	return st.s
}

func (st *SecretStore) Update(f func(s *Secrets)) error {
	st.mu.Lock()
	defer st.mu.Unlock()
	f(&st.s)
	data, _ := json.MarshalIndent(st.s, "", "  ")
	return writeFileAtomic(st.path, data, 0o600)
}
