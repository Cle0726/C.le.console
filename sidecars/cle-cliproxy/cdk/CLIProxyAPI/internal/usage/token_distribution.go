// Package usage provides token usage utilities including cache token distribution.
package usage

// CacheTokenDistribution represents the distributed token usage for Claude API compatibility.
// This implements the 1:2:25 cache token distribution ratio used by Kiro to simulate
// Claude API prompt caching behavior.
type CacheTokenDistribution struct {
	InputTokens              int64
	CacheCreationInputTokens int64
	CacheReadInputTokens     int64
}

// Distribution ratio constants
const (
	// DistributionThreshold is the minimum token count for distribution to apply.
	// Below this value, all tokens are assigned to InputTokens.
	DistributionThreshold int64 = 100

	// Distribution ratio parts: 1:2:25 = 28 total parts
	inputRatioPart    = 1
	creationRatioPart = 2
	readRatioPart     = 25
	totalRatioParts   = inputRatioPart + creationRatioPart + readRatioPart // 28
)

// DistributeCacheTokens applies the 1:2:25 token distribution ratio.
// This matches the Node.js implementation in AIClient-2-API RatioTokenDistribution.js.
//
// Algorithm:
//   - Total parts = 1 + 2 + 25 = 28
//   - input_tokens = floor(tokens * 1 / 28)
//   - cache_creation_input_tokens = floor(tokens * 2 / 28)
//   - cache_read_input_tokens = tokens - input - creation (gets remainder)
//
// Threshold: 100 tokens (below this, no distribution applied)
//
// Example:
//
//	DistributeCacheTokens(1000) returns:
//	  InputTokens:              35  (1000 * 1 / 28)
//	  CacheCreationInputTokens: 71  (1000 * 2 / 28)
//	  CacheReadInputTokens:     894 (remainder)
func DistributeCacheTokens(totalInputTokens int64) CacheTokenDistribution {
	// Below threshold: no distribution, all tokens go to InputTokens
	if totalInputTokens < DistributionThreshold {
		return CacheTokenDistribution{
			InputTokens: totalInputTokens,
		}
	}

	// Apply 1:2:25 ratio
	input := totalInputTokens * inputRatioPart / totalRatioParts
	creation := totalInputTokens * creationRatioPart / totalRatioParts
	read := totalInputTokens - input - creation // Remainder goes to cache_read

	return CacheTokenDistribution{
		InputTokens:              input,
		CacheCreationInputTokens: creation,
		CacheReadInputTokens:     read,
	}
}

// TotalInputTokens returns the sum of all input-related tokens,
// which equals the original input before distribution.
func (d CacheTokenDistribution) TotalInputTokens() int64 {
	return d.InputTokens + d.CacheCreationInputTokens + d.CacheReadInputTokens
}

// HasCacheTokens returns true if any cache tokens are present.
func (d CacheTokenDistribution) HasCacheTokens() bool {
	return d.CacheCreationInputTokens > 0 || d.CacheReadInputTokens > 0
}
