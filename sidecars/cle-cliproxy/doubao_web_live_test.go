package main

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"
)

// Runs only with DOUBAO_WEB_LIVE_COOKIE_FILE pointing at a C.le portable credential file.
func TestDoubaoWebLiveChat(t *testing.T) {
	path := os.Getenv("DOUBAO_WEB_LIVE_COOKIE_FILE")
	if path == "" {
		t.Skip("set DOUBAO_WEB_LIVE_COOKIE_FILE to run against the real Doubao")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Cookies []struct{ Name, Value string } `json:"cookies"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	pairs := make([]string, 0, len(file.Cookies))
	for _, c := range file.Cookies {
		pairs = append(pairs, c.Name+"="+c.Value)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	started := time.Now()
	reply, err := newDoubaoWebClient(strings.Join(pairs, "; "), nil).Complete(ctx, "只回两个字：收到")
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("%.1fs answer=%q thinking=%d conversation=%t", time.Since(started).Seconds(), reply.Answer, len(reply.Thinking), reply.ConversationID != "")
}

func TestDoubaoWebLiveToolCalls(t *testing.T) {
	path := os.Getenv("DOUBAO_WEB_LIVE_COOKIE_FILE")
	if path == "" {
		t.Skip("set DOUBAO_WEB_LIVE_COOKIE_FILE to run against the real Doubao")
	}
	raw, _ := os.ReadFile(path)
	var file struct {
		Cookies []struct{ Name, Value string } `json:"cookies"`
	}
	_ = json.Unmarshal(raw, &file)
	pairs := []string{}
	for _, c := range file.Cookies {
		pairs = append(pairs, c.Name+"="+c.Value)
	}
	client := newDoubaoWebClient(strings.Join(pairs, "; "), nil)
	tools := `[{"type":"function","function":{"name":"read","description":"读取一个文件的内容","parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}},
	{"type":"function","function":{"name":"exec","description":"在本机执行一条 shell 命令","parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}}]`
	sys := `{"role":"system","content":"你是本机助手。需要信息时调用工具，不要编造工具结果。"}`
	cases := map[string]string{
		"1 single":   `[` + sys + `,{"role":"user","content":"看一下 D:/notes/todo.md 里写了什么"}]`,
		"2 parallel": `[` + sys + `,{"role":"user","content":"同时读 D:/a.txt 和 D:/b.txt，告诉我两者的区别"}]`,
		"3 no tool":  `[` + sys + `,{"role":"user","content":"1+1 等于几？"}]`,
		"4 after result": `[` + sys + `,{"role":"user","content":"看一下 D:/notes/todo.md 里写了什么"},
			{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"read","arguments":"{\"path\":\"D:/notes/todo.md\"}"}}]},
			{"role":"tool","tool_call_id":"call_1","content":"- 周五交报告\n- 给妈妈打电话\n- 买牛奶"}]`,
	}
	for _, name := range []string{"1 single", "2 parallel", "3 no tool", "4 after result"} {
		var payload map[string]any
		_ = json.Unmarshal([]byte(`{"tools":`+tools+`,"messages":`+cases[name]+`}`), &payload)
		toolList, _ := doubaoWebTools(payload)
		prompt, err := doubaoWebPrompt(payload, toolList)
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		started := time.Now()
		reply, err := client.Complete(ctx, prompt)
		cancel()
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		text, calls := doubaoWebParseToolCalls(reply.Answer, toolList)
		got := []string{}
		for _, c := range calls {
			got = append(got, c.Name+" "+c.Arguments)
		}
		t.Logf("%s %.1fs calls=%v text=%q raw=%q", name, time.Since(started).Seconds(), got, string([]rune(text)[:min(len([]rune(text)), 60)]), string([]rune(reply.Answer)[:min(len([]rune(reply.Answer)), 160)]))
	}
}

// DOUBAO_WEB_LIVE_MODELS: comma-separated model_item_keys ("auto" for the default).
func TestDoubaoWebLiveModels(t *testing.T) {
	path, list := os.Getenv("DOUBAO_WEB_LIVE_COOKIE_FILE"), os.Getenv("DOUBAO_WEB_LIVE_MODELS")
	if path == "" || list == "" {
		t.Skip("set DOUBAO_WEB_LIVE_COOKIE_FILE and DOUBAO_WEB_LIVE_MODELS")
	}
	raw, _ := os.ReadFile(path)
	var file struct {
		Cookies []struct{ Name, Value string } `json:"cookies"`
	}
	_ = json.Unmarshal(raw, &file)
	pairs := []string{}
	for _, c := range file.Cookies {
		pairs = append(pairs, c.Name+"="+c.Value)
	}
	for _, model := range strings.Split(list, ",") {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		started := time.Now()
		reply, err := newDoubaoWebClient(strings.Join(pairs, "; "), nil).withModel(doubaoWebModelKey(model)).Complete(ctx, "你是哪家公司开发的什么模型？只用一句话回答。")
		cancel()
		if err != nil {
			t.Errorf("%s: %v", model, err)
			continue
		}
		t.Logf("%s %.1fs %s", model, time.Since(started).Seconds(), reply.Answer)
	}
}
