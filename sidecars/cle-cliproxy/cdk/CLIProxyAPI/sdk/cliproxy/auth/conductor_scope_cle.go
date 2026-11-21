package auth

import (
	"context"
	"fmt"
	"strings"
)

// C.le: client API keys may be limited to a set of auth IDs through the
// config's api-key-account-ids map. The access provider puts the allowed IDs
// into accessMetadata["account_ids"]; selection skips every other credential.

func scopedAccountIDSetFromContext(ctx context.Context) map[string]struct{} {
	if ctx == nil {
		return nil
	}
	ginCtx, ok := ctx.Value("gin").(interface{ Get(string) (any, bool) })
	if !ok || ginCtx == nil {
		return nil
	}
	rawMetadata, ok := ginCtx.Get("accessMetadata")
	if !ok {
		return nil
	}
	var accountIDs string
	switch v := rawMetadata.(type) {
	case map[string]string:
		accountIDs = strings.TrimSpace(v["account_ids"])
	case map[string]any:
		if raw, okValue := v["account_ids"]; okValue && raw != nil {
			accountIDs = strings.TrimSpace(fmt.Sprint(raw))
		}
	}
	if accountIDs == "" {
		return nil
	}
	out := make(map[string]struct{})
	for _, item := range strings.Split(accountIDs, ",") {
		if accountID := strings.TrimSpace(item); accountID != "" {
			out[accountID] = struct{}{}
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

func authAllowedByScope(auth *Auth, scopedAccountIDs map[string]struct{}) bool {
	if len(scopedAccountIDs) == 0 {
		return true
	}
	if auth == nil {
		return false
	}
	_, ok := scopedAccountIDs[auth.ID]
	return ok
}
