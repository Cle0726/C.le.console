package responses

import "context"

// CompleteOpenAIChatCompletionsResponseToOpenAIResponses emits the terminal
// events when an OpenAI-compatible upstream closes the stream after starting a
// response but without sending [DONE]. It reuses the converter's own [DONE]
// path so tool items and usage are finalized the same way. (C.le sidecar)
func CompleteOpenAIChatCompletionsResponseToOpenAIResponses(ctx context.Context, requestRawJSON []byte, param *any) [][]byte {
	if param == nil || *param == nil {
		return [][]byte{}
	}
	st, ok := (*param).(*oaiToResponsesState)
	if !ok || !st.Started || st.CompletedEmitted {
		return [][]byte{}
	}
	return ConvertOpenAIChatCompletionsResponseToOpenAIResponses(ctx, "", requestRawJSON, requestRawJSON, []byte("[DONE]"), param)
}
