package executor

import (
	"fmt"
	"github.com/tidwall/gjson"
	"github.com/tiktoken-go/tokenizer"
	"regexp"
	"strconv"
	"strings"
)

func countClaudeChatTokens(enc tokenizer.Codec, payload []byte) (int64, error) {
	if enc == nil {
		return 0, fmt.Errorf("encoder is nil")
	}
	if len(payload) == 0 {
		return 0, nil
	}

	root := gjson.ParseBytes(payload)
	segments := make([]string, 0, 32)

	// Collect system prompt (can be string or array of content blocks)
	collectClaudeSystem(root.Get("system"), &segments)

	// Collect messages
	collectClaudeMessages(root.Get("messages"), &segments)

	// Collect tools
	collectClaudeTools(root.Get("tools"), &segments)

	joined := strings.TrimSpace(strings.Join(segments, "\n"))
	if joined == "" {
		return 0, nil
	}

	// Count text tokens
	count, err := enc.Count(joined)
	if err != nil {
		return 0, err
	}

	// Extract and add image tokens from placeholders
	imageTokens := extractImageTokens(joined)

	return int64(count) + int64(imageTokens), nil
}

// imageTokenPattern matches [IMAGE:xxx tokens] format for extracting estimated image tokens
var imageTokenPattern = regexp.MustCompile(`\[IMAGE:(\d+) tokens\]`)

// extractImageTokens extracts image token estimates from placeholder text.
// Placeholders are in the format [IMAGE:xxx tokens] where xxx is the estimated token count.
func extractImageTokens(text string) int {
	matches := imageTokenPattern.FindAllStringSubmatch(text, -1)
	total := 0
	for _, match := range matches {
		if len(match) > 1 {
			if tokens, err := strconv.Atoi(match[1]); err == nil {
				total += tokens
			}
		}
	}
	return total
}

// estimateImageTokens calculates estimated tokens for an image based on dimensions.
// Based on Claude's image token calculation: tokens ≈ (width * height) / 750
// Minimum 85 tokens, maximum 1590 tokens (for 1568x1568 images).
func estimateImageTokens(width, height float64) int {
	if width <= 0 || height <= 0 {
		// No valid dimensions, use default estimate (medium-sized image)
		return 1000
	}

	tokens := int(width * height / 750)

	// Apply bounds
	if tokens < 85 {
		tokens = 85
	}
	if tokens > 1590 {
		tokens = 1590
	}

	return tokens
}

// collectClaudeSystem extracts text from Claude's system field.
// System can be a string or an array of content blocks.
func collectClaudeSystem(system gjson.Result, segments *[]string) {
	if !system.Exists() {
		return
	}
	if system.Type == gjson.String {
		addIfNotEmpty(segments, system.String())
		return
	}
	if system.IsArray() {
		system.ForEach(func(_, block gjson.Result) bool {
			blockType := block.Get("type").String()
			if blockType == "text" || blockType == "" {
				addIfNotEmpty(segments, block.Get("text").String())
			}
			// Also handle plain string blocks
			if block.Type == gjson.String {
				addIfNotEmpty(segments, block.String())
			}
			return true
		})
	}
}

// collectClaudeMessages extracts text from Claude's messages array.
func collectClaudeMessages(messages gjson.Result, segments *[]string) {
	if !messages.Exists() || !messages.IsArray() {
		return
	}
	messages.ForEach(func(_, message gjson.Result) bool {
		addIfNotEmpty(segments, message.Get("role").String())
		collectClaudeContent(message.Get("content"), segments)
		return true
	})
}

// collectClaudeContent extracts text from Claude's content field.
// Content can be a string or an array of content blocks.
// For images, estimates token count based on dimensions when available.
func collectClaudeContent(content gjson.Result, segments *[]string) {
	if !content.Exists() {
		return
	}
	if content.Type == gjson.String {
		addIfNotEmpty(segments, content.String())
		return
	}
	if content.IsArray() {
		content.ForEach(func(_, part gjson.Result) bool {
			partType := part.Get("type").String()
			switch partType {
			case "text":
				addIfNotEmpty(segments, part.Get("text").String())
			case "image":
				// Estimate image tokens based on dimensions if available
				source := part.Get("source")
				if source.Exists() {
					width := source.Get("width").Float()
					height := source.Get("height").Float()
					if width > 0 && height > 0 {
						tokens := estimateImageTokens(width, height)
						addIfNotEmpty(segments, fmt.Sprintf("[IMAGE:%d tokens]", tokens))
					} else {
						// No dimensions available, use default estimate
						addIfNotEmpty(segments, "[IMAGE:1000 tokens]")
					}
				} else {
					// No source info, use default estimate
					addIfNotEmpty(segments, "[IMAGE:1000 tokens]")
				}
			case "tool_use":
				addIfNotEmpty(segments, part.Get("id").String())
				addIfNotEmpty(segments, part.Get("name").String())
				if input := part.Get("input"); input.Exists() {
					addIfNotEmpty(segments, input.Raw)
				}
			case "tool_result":
				addIfNotEmpty(segments, part.Get("tool_use_id").String())
				collectClaudeContent(part.Get("content"), segments)
			case "thinking":
				addIfNotEmpty(segments, part.Get("thinking").String())
			default:
				// For unknown types, try to extract any text content
				if part.Type == gjson.String {
					addIfNotEmpty(segments, part.String())
				} else if part.Type == gjson.JSON {
					addIfNotEmpty(segments, part.Raw)
				}
			}
			return true
		})
	}
}

// collectClaudeTools extracts text from Claude's tools array.
func collectClaudeTools(tools gjson.Result, segments *[]string) {
	if !tools.Exists() || !tools.IsArray() {
		return
	}
	tools.ForEach(func(_, tool gjson.Result) bool {
		addIfNotEmpty(segments, tool.Get("name").String())
		addIfNotEmpty(segments, tool.Get("description").String())
		if inputSchema := tool.Get("input_schema"); inputSchema.Exists() {
			addIfNotEmpty(segments, inputSchema.Raw)
		}
		return true
	})
}

func addIfNotEmpty(segments *[]string, value string) {
	if segments == nil {
		return
	}
	if trimmed := strings.TrimSpace(value); trimmed != "" {
		*segments = append(*segments, trimmed)
	}
}
