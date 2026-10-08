package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestDoubaoWorkPromptConvertsChatAndResponsesText(t *testing.T) {
	chat, err := doubaoWorkPrompt([]byte(`{"messages":[{"role":"system","content":"Be concise"},{"role":"user","content":"你好"}]}`), false)
	if err != nil {
		t.Fatal(err)
	}
	if chat != "SYSTEM:\nBe concise\n\nUSER:\n你好" {
		t.Fatalf("unexpected chat prompt: %q", chat)
	}

	responses, err := doubaoWorkPrompt([]byte(`{"instructions":"Be concise","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"你好"}]}]}`), true)
	if err != nil {
		t.Fatal(err)
	}
	if responses != "System instructions:\nBe concise\n\nUSER:\n你好" {
		t.Fatalf("unexpected Responses prompt: %q", responses)
	}
}

func TestDoubaoWorkPromptRejectsMultimodalInput(t *testing.T) {
	_, err := doubaoWorkPrompt([]byte(`{"messages":[{"role":"user","content":[{"type":"image_url","image_url":{"url":"https://example.com/image.png"}}]}]}`), false)
	if err == nil || !strings.Contains(err.Error(), "只接受文本") {
		t.Fatalf("expected a clear text-only error, got %v", err)
	}
}

func TestDoubaoWorkPromptRejectsUnsupportedToolsAndResponseContinuation(t *testing.T) {
	chatErr := func() error {
		_, err := doubaoWorkPrompt([]byte(`{"messages":[{"role":"user","content":"hi"}],"tools":[{"type":"function"}]}`), false)
		return err
	}()
	if chatErr == nil || !strings.Contains(chatErr.Error(), "不支持 OpenAI 工具调用") {
		t.Fatalf("expected a clear tool-call error, got %v", chatErr)
	}

	responsesErr := func() error {
		_, err := doubaoWorkPrompt([]byte(`{"previous_response_id":"resp_old","input":"continue"}`), true)
		return err
	}()
	if responsesErr == nil || !strings.Contains(responsesErr.Error(), "previous_response_id") {
		t.Fatalf("expected a clear continuation error, got %v", responsesErr)
	}
}

func TestRunDoubaoWorkTaskCreatesAndWaitsForAgent(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the fake CLI helper uses a POSIX shell")
	}
	cliPath := filepath.Join(t.TempDir(), "doubao")
	script := `#!/bin/sh
[ "$1" = "--profile" ] && [ "$2" = "Profile 1" ] || exit 3
shift 2
[ "$1" = "--app" ] && [ "$2" = "doubao" ] || exit 4
while [ "$#" -gt 0 ]; do
  [ "$1" = "sessions" ] && { shift; break; }
  shift
done
case "$1" in
  create) printf '%s\n' '{"conversationId":"conv-1","runId":"run-1","status":"running"}' ;;
  wait) printf '%s\n' '{"conversationId":"conv-1","runId":"run-1","status":"completed","reply":"hello from doubao"}' ;;
  *) printf '%s\n' "unexpected CLI command: $*" >&2; exit 2 ;;
esac
`
	if err := os.WriteFile(cliPath, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}

	reply, err := runDoubaoWorkTask(context.Background(), cliPath, "doubao", "Profile 1", "gpt-6-sol", "USER:\nhello")
	if err != nil {
		t.Fatal(err)
	}
	if reply != "hello from doubao" {
		t.Fatalf("unexpected final reply: %q", reply)
	}
}

func TestDoubaoWorkQuotaNoticeIsNotACompletedAnswer(t *testing.T) {
	message := "最近视频创作消耗了较多额度，近 7 天的额度用完了，预计 10 月 2 日恢复为你服务。升级你的订阅套餐可继续使用。"
	if !doubaoWorkQuotaExceeded(message) {
		t.Fatal("expected a subscription quota notice to be detected")
	}
	if doubaoWorkQuotaExceeded("请解释为什么额度用完后需要等待恢复") {
		t.Fatal("ordinary answer text must not be mistaken for a quota notice")
	}
}

func TestDoubaoWorkPoolSelectsTheActiveDesktopProfile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the fake CLI helper uses a POSIX shell")
	}
	cliPath := filepath.Join(t.TempDir(), "doubao")
	script := `#!/bin/sh
printf '%s\n' '{"running":true,"profile":{"directory":"Profile 4"}}'
`
	if err := os.WriteFile(cliPath, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	model := "doubao-work/auto"
	server := &relayServer{manifest: &manifest{Accounts: []accountSpec{
		{ID: "old", Provider: doubaoWorkProvider, CLIPath: cliPath, CLIApp: "doubao", CLIProfile: "Default", Models: []string{model}},
		{ID: "active", Provider: doubaoWorkProvider, CLIPath: cliPath, CLIApp: "doubao", CLIProfile: "Profile 4", Models: []string{model}},
	}}}
	selected := server.findDoubaoWorkAccount(context.Background(), nil, model)
	if selected == nil || selected.ID != "active" {
		t.Fatalf("expected the active profile, got %#v", selected)
	}
}

func TestDoubaoWorkChatHandlerReturnsOpenAICompletion(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the fake CLI helper uses a POSIX shell")
	}
	cliPath := filepath.Join(t.TempDir(), "doubao")
	script := `#!/bin/sh
[ "$1" = "--profile" ] && [ "$2" = "Profile 1" ] || exit 3
while [ "$#" -gt 0 ]; do
  [ "$1" = "sessions" ] && { shift; break; }
  shift
done
case "$1" in
  create) printf '%s\n' '{"conversationId":"conv-1","runId":"run-1","status":"running"}' ;;
  wait) printf '%s\n' '{"status":"completed","reply":"豆包工作 Agent 已回复"}' ;;
  *) exit 2 ;;
esac
`
	if err := os.WriteFile(cliPath, []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}

	model := "doubao-work/gpt-6-sol"
	manifest := &manifest{
		ModelIDs: []string{model},
		Accounts: []accountSpec{{ID: "work-1", Provider: doubaoWorkProvider, CLIPath: cliPath, CLIProfile: "Profile 1", Models: []string{model}}},
	}
	server := &relayServer{manifest: manifest}
	recorder := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(recorder)
	c.Request = httptest.NewRequest(http.MethodPost, "/v1/chat/completions", bytes.NewBufferString(`{"model":"doubao-work/gpt-6-sol","messages":[{"role":"user","content":"你好"}]}`))
	spec := &apiKeySpec{AllowedModels: []string{model}}
	server.handleDoubaoWorkChat(c, spec, []byte(`{"model":"doubao-work/gpt-6-sol","messages":[{"role":"user","content":"你好"}]}`), false)

	if recorder.Code != http.StatusOK {
		t.Fatalf("unexpected status %d: %s", recorder.Code, recorder.Body.String())
	}
	var payload struct {
		Object  string `json:"object"`
		Model   string `json:"model"`
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Object != "chat.completion" || payload.Model != model || len(payload.Choices) != 1 || payload.Choices[0].Message.Content != "豆包工作 Agent 已回复" {
		t.Fatalf("unexpected completion response: %#v", payload)
	}
}
