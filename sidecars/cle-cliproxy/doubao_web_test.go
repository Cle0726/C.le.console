package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

type doubaoWebRT func(*http.Request) (*http.Response, error)

func (f doubaoWebRT) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func doubaoWebSSE(status int, body string) doubaoWebRT {
	return func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{"text/event-stream"}}, Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
	}
}

const doubaoWebTestCookie = "sessionid=abc; passport_csrf_token=tok; ttwid=1"

func doubaoWebChunk(text string) string {
	raw, _ := json.Marshal(map[string]any{"patch_op": []any{map[string]any{"patch_value": map[string]any{"content_block": []any{
		map[string]any{"block_type": 10000, "content": map[string]any{"text_block": map[string]any{"text": text}}},
	}}}}})
	return "event: STREAM_CHUNK\ndata: " + string(raw) + "\n\n"
}

const doubaoWebAck = "event: SSE_ACK\ndata: {\"ack_client_meta\":{\"conversation_id\":\"123456789012\"},\"query_list\":[{\"question_id\":\"223456789012\"}]}\n\n"

func TestDoubaoWebCompleteCollectsChunksAndSendsCookies(t *testing.T) {
	var seen *http.Request
	var sent map[string]any
	rt := func(r *http.Request) (*http.Response, error) {
		seen = r
		_ = json.NewDecoder(r.Body).Decode(&sent)
		return doubaoWebSSE(200, doubaoWebAck+doubaoWebChunk("你")+"\r\n"+doubaoWebChunk("好")+"event: SSE_REPLY_END\ndata: {\"end_type\":3}\n\n")(r)
	}
	reply, err := newDoubaoWebClient(doubaoWebTestCookie, doubaoWebRT(rt)).Complete(context.Background(), "hi")
	if err != nil {
		t.Fatal(err)
	}
	if reply.Answer != "你好" || reply.ConversationID != "123456789012" {
		t.Fatalf("reply %+v", reply)
	}
	if seen.URL.Host != "www.doubao.com" || seen.URL.Path != "/chat/completion" || seen.Header.Get("Cookie") != doubaoWebTestCookie || seen.Header.Get("X-Tt-Passport-Csrf-Token") != "tok" {
		t.Fatalf("request %s %v", seen.URL, seen.Header)
	}
	option := sent["option"].(map[string]any)
	if option["agent_mode"].(float64) != 2 {
		t.Fatal("must use plain chat mode, never the local-runtime agent")
	}
}

// As seen live: the reply opens with STREAM_MSG_NOTIFY carrying the first chunk, and
// the end event's brief replaces code blocks with "[代码]".
func TestDoubaoWebCompleteKeepsFirstChunkAndIgnoresBrief(t *testing.T) {
	notify := "event: STREAM_MSG_NOTIFY\ndata: {\"meta\":{\"message_id\":\"1\"},\"content\":{\"content_block\":[{\"block_type\":10000,\"content\":{\"text_block\":{\"text\":\"```\"}}}]}}\n\n"
	end := "event: SSE_REPLY_END\ndata: {\"end_type\":1,\"msg_finish_attr\":{\"brief\":\"[代码]\"}}\n\n"
	body := doubaoWebAck + notify + doubaoWebChunk("tool_call\n{\"name\":\"read\",\"arguments\":{}}\n") + doubaoWebChunk("```") + end
	reply, err := newDoubaoWebClient(doubaoWebTestCookie, doubaoWebSSE(200, body)).Complete(context.Background(), "hi")
	if err != nil {
		t.Fatal(err)
	}
	if reply.Answer != "```tool_call\n{\"name\":\"read\",\"arguments\":{}}\n```" {
		t.Fatalf("answer %q", reply.Answer)
	}
	// brief is still the fallback when nothing was streamed
	reply, err = newDoubaoWebClient(doubaoWebTestCookie, doubaoWebSSE(200, doubaoWebAck+"event: SSE_REPLY_END\ndata: {\"end_type\":1,\"msg_finish_attr\":{\"brief\":\"好的\"}}\n\n")).Complete(context.Background(), "hi")
	if err != nil || reply.Answer != "好的" {
		t.Fatalf("brief fallback: %v %+v", err, reply)
	}
}

func TestDoubaoWebCompleteFailures(t *testing.T) {
	cases := map[string]struct {
		cookie string
		rt     doubaoWebRT
		want   error
	}{
		"no session cookie": {"ttwid=1", doubaoWebSSE(200, doubaoWebAck), errDoubaoWebLoginRequired},
		"401":               {doubaoWebTestCookie, doubaoWebSSE(401, ""), errDoubaoWebLoginRequired},
		"quota reply":       {doubaoWebTestCookie, doubaoWebSSE(200, doubaoWebAck+doubaoWebChunk("近 7 天免费额度已用完，预计11月22日恢复。开通订阅畅享更多额度。")), errDoubaoWebQuotaExceeded},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := newDoubaoWebClient(tc.cookie, tc.rt).Complete(context.Background(), "hi")
			if !errors.Is(err, tc.want) {
				t.Fatalf("err %v, want %v", err, tc.want)
			}
		})
	}
	for name, body := range map[string]string{
		"no ack":       doubaoWebChunk("hi"),
		"empty answer": doubaoWebAck + "event: SSE_REPLY_END\ndata: {\"end_type\":3}\n\n",
		"stream error": doubaoWebAck + "event: STREAM_ERROR\ndata: {\"error_code\":710022004,\"error_msg\":\"busy\"}\n\n",
		"bad json":     doubaoWebAck + "event: STREAM_CHUNK\ndata: {oops\n\n",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := newDoubaoWebClient(doubaoWebTestCookie, doubaoWebSSE(200, body)).Complete(context.Background(), "hi"); err == nil {
				t.Fatal("expected an error")
			}
		})
	}
}

var doubaoWebTestTools = []doubaoWebTool{{Name: "read"}, {Name: "exec"}, {Name: "web-fetch"}}

func TestDoubaoWebParseToolCalls(t *testing.T) {
	text, calls := doubaoWebParseToolCalls(`<tool_call>{"name": "read", "arguments": {"path": "D:/a.txt"}}</tool_call>
<tool_call>{"name":"web-fetch","arguments":"{\"url\":\"https://x\"}"}</tool_call>`, doubaoWebTestTools)
	if text != "" || len(calls) != 2 || calls[0].Name != "read" || calls[0].Arguments != `{"path": "D:/a.txt"}` || calls[1].Name != "web-fetch" || calls[1].Arguments != `{"url":"https://x"}` {
		t.Fatalf("text %q calls %+v", text, calls)
	}
	if calls[0].ID == calls[1].ID || !strings.HasPrefix(calls[0].ID, "call_") {
		t.Fatal("call ids must be unique")
	}
	// fenced block, narration around it
	text, calls = doubaoWebParseToolCalls("我先看一下。\n```xml\n<tool_call>{\"name\":\"exec\",\"arguments\":{\"command\":\"dir\"}}</tool_call>\n```", doubaoWebTestTools)
	if len(calls) != 1 || calls[0].Name != "exec" || text != "我先看一下。" {
		t.Fatalf("fenced: text %q calls %+v", text, calls)
	}
	// the format the prompt asks for: ```tool_call fences, two in one reply
	text, calls = doubaoWebParseToolCalls("我先读文件。\n\n```tool_call\n{\"name\": \"read\", \"arguments\": {\"path\": \"a.txt\"}}\n```\n\n```tool_call\n{\"name\":\"exec\",\"arguments\":{\"command\":\"dir\"}}\n```", doubaoWebTestTools)
	if len(calls) != 2 || calls[0].Name != "read" || calls[1].Name != "exec" || text != "我先读文件。" {
		t.Fatalf("tool_call fences: text %q calls %+v", text, calls)
	}
	// model tagged the fence json, with parameters instead of arguments
	text, calls = doubaoWebParseToolCalls("```json\n{\"name\":\"read\",\"parameters\":{\"path\":\"b\"}}\n```", doubaoWebTestTools)
	if len(calls) != 1 || calls[0].Arguments != `{"path":"b"}` || text != "" {
		t.Fatalf("json fence: text %q calls %+v", text, calls)
	}
	// fallback: the page stripped the fence and only bare JSON is left (one object, objects per line, an array)
	for _, reply := range []string{
		`{"name":"read","arguments":{"path":"a"}}`,
		"{\"name\":\"read\",\"arguments\":{\"path\":\"a\"}}\n{\"name\":\"exec\",\"arguments\":{}}",
		`[{"name":"read","arguments":{"path":"a"}},{"name":"exec","arguments":{}}]`,
	} {
		text, calls = doubaoWebParseToolCalls(reply, doubaoWebTestTools)
		if len(calls) == 0 || calls[0].Name != "read" || text != "" {
			t.Fatalf("bare %q -> text %q calls %+v", reply, text, calls)
		}
	}
	// ordinary code and JSON answers are not calls
	for _, reply := range []string{
		"示例：\n```json\n{\"path\": \"a\"}\n```",
		"```python\nprint(1)\n```",
		`{"name":"read","arguments":"not json"}`,
		`{"name":"read","arguments":[1]}`,
		"答案是 {\"name\":\"read\",\"arguments\":{}} 这样写",
	} {
		text, calls = doubaoWebParseToolCalls(reply, doubaoWebTestTools)
		if len(calls) != 0 || text != reply {
			t.Fatalf("%q -> text %q calls %+v", reply, text, calls)
		}
	}
	// unknown tool and broken JSON stay as text, nothing is guessed
	for _, reply := range []string{
		`<tool_call>{"name":"rm_rf","arguments":{}}</tool_call>`,
		`<tool_call>{"name":"read","arguments":{"path":}</tool_call>`,
		`<tool_call>{"name":"read"`,
	} {
		text, calls = doubaoWebParseToolCalls(reply, doubaoWebTestTools)
		if len(calls) != 0 || text != reply {
			t.Fatalf("%q -> text %q calls %+v", reply, text, calls)
		}
	}
	// no tools offered: a call-looking answer is just text
	if _, calls = doubaoWebParseToolCalls(`<tool_call>{"name":"read","arguments":{}}</tool_call>`, nil); len(calls) != 0 {
		t.Fatal("parsed calls with no tools offered")
	}
}

func TestDoubaoWebPromptRendersHistoryAndTools(t *testing.T) {
	var payload map[string]any
	_ = json.Unmarshal([]byte(`{"tools":[{"type":"function","function":{"name":"read","description":"读文件","parameters":{"type":"object"}}}],
	"messages":[{"role":"system","content":"你是助手"},{"role":"user","content":"看 a.txt"},
	{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"read","arguments":"{\"path\":\"a.txt\"}"}}]},
	{"role":"tool","tool_call_id":"call_1","content":"第一行"}]}`), &payload)
	tools, err := doubaoWebTools(payload)
	if err != nil || len(tools) != 1 {
		t.Fatal(err, tools)
	}
	prompt, err := doubaoWebPrompt(payload, tools)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"【系统指令】\n你是助手", `"name": "read"`, "【用户】\n看 a.txt", "```tool_call\n{\"name\": \"read\", \"arguments\": {\"path\":\"a.txt\"}}\n```\n（调用编号 call_1）", "【工具结果（调用编号 call_1）】\n第一行"} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("prompt lacks %q:\n%s", want, prompt)
		}
	}
	if strings.Index(prompt, "可用工具") > strings.Index(prompt, "对话记录") {
		t.Fatal("tool instructions must come before the history")
	}
	_ = json.Unmarshal([]byte(`{"tool_choice":"none","tools":[{"type":"function","function":{"name":"read"}}]}`), &payload)
	if tools, _ = doubaoWebTools(payload); len(tools) != 0 {
		t.Fatal("tool_choice none must hide tools")
	}
}
