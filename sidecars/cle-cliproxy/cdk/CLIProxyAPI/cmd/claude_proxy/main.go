package main

import (
	"io/ioutil"
	"log"
	"net/http"
	"strings"

	"github.com/imroc/req/v3"
)

func main() {
	client := req.C().ImpersonateChrome()

	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		// Only proxy requests targeting claude.ai
		targetURL := "https://claude.ai" + r.URL.Path
		if r.URL.RawQuery != "" {
			targetURL += "?" + r.URL.RawQuery
		}

		// Read body
		bodyBytes, _ := ioutil.ReadAll(r.Body)

		reqBuilder := client.R()

		// Copy headers
		for k, v := range r.Header {
			if strings.ToLower(k) != "host" && strings.ToLower(k) != "accept-encoding" {
				reqBuilder.SetHeader(k, v[0])
			}
		}

		var resp *req.Response
		var err error
		if r.Method == "GET" {
			resp, err = reqBuilder.Get(targetURL)
		} else if r.Method == "POST" {
			resp, err = reqBuilder.SetBody(bodyBytes).Post(targetURL)
		} else {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}

		for k, v := range resp.Header {
			w.Header().Set(k, v[0])
		}
		w.WriteHeader(resp.StatusCode)
		respBody, _ := resp.ToBytes()
		w.Write(respBody)
	})

	log.Println("Starting Claude CF-Bypass proxy on 127.0.0.1:8766")
	log.Fatal(http.ListenAndServe("127.0.0.1:8766", nil))
}
