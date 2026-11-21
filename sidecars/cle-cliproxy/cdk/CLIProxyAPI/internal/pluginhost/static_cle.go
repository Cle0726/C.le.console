package pluginhost

// C.le: in-process plugins compiled into the host binary. The cle-cliproxy
// sidecar embeds the official Gemini CLI provider plugin this way so no
// native plugin library has to be shipped or loaded.

import (
	"strings"

	"github.com/router-for-me/CLIProxyAPI/v8/sdk/pluginapi"
)

// RegisterStaticPlugin registers an in-process plugin. It stays active across
// ApplyConfig calls regardless of the plugin directory configuration.
func (h *Host) RegisterStaticPlugin(id string, priority int, plugin pluginapi.Plugin) {
	if h == nil {
		return
	}
	id = strings.TrimSpace(id)
	if id == "" {
		return
	}
	plugin.Metadata = clonePluginMetadata(plugin.Metadata)
	record := capabilityRecord{
		id:       id,
		path:     "static/" + id,
		version:  strings.TrimSpace(plugin.Metadata.Version),
		meta:     plugin.Metadata,
		plugin:   plugin,
		priority: priority,
	}
	h.mu.Lock()
	kept := h.staticRecords[:0]
	for _, existing := range h.staticRecords {
		if existing.id != id {
			kept = append(kept, existing)
		}
	}
	h.staticRecords = append(kept, record)
	h.mu.Unlock()

	records := make([]capabilityRecord, 0)
	for _, active := range h.activeRecords() {
		if active.id != id {
			records = append(records, active)
		}
	}
	records = append(records, record)
	sortRecords(records)
	h.mu.Lock()
	h.rebuildActivePluginMapsLocked(records)
	h.snapshot.Store(&Snapshot{enabled: true, records: records, quotaSupportedProviders: make(map[string][]string)})
	h.mu.Unlock()
	h.refreshThinkingProviders(records)
}

func (h *Host) staticRecordsCopy() []capabilityRecord {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]capabilityRecord(nil), h.staticRecords...)
}

func (h *Host) appendStaticRecords(records []capabilityRecord) []capabilityRecord {
	static := h.staticRecordsCopy()
	if len(static) == 0 {
		return records
	}
	ids := make(map[string]struct{}, len(records))
	for _, record := range records {
		ids[record.id] = struct{}{}
	}
	for _, record := range static {
		if _, exists := ids[record.id]; !exists {
			records = append(records, record)
		}
	}
	return records
}

// storeStaticOnlyRecords publishes only the static plugins (or nothing).
func (h *Host) storeStaticOnlyRecords() {
	records := h.appendStaticRecords(nil)
	sortRecords(records)
	h.mu.Lock()
	h.rebuildActivePluginMapsLocked(records)
	if len(records) == 0 {
		h.snapshot.Store(emptySnapshot())
	} else {
		h.snapshot.Store(&Snapshot{enabled: true, records: records, quotaSupportedProviders: make(map[string][]string)})
	}
	h.mu.Unlock()
	h.refreshThinkingProviders(records)
}
