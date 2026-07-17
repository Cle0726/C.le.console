const http = require('node:http');

const server = http.createServer(async (req, res) => {
  const { method, url, headers } = req;

  if (method === 'GET' && url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (method === 'POST' && /\/api\/organizations\/[^/]+\/chat_conversations\/[^/]+\/completion$/.test(url || '')) {
    const cookie = String(headers.cookie || '');
    if (cookie.includes('sessionKey=sk-disabled-placeholder')) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        type: 'error',
        error: {
          type: 'permission_error',
          message: 'Invalid authorization',
          details: { error_code: 'account_session_invalid', error_visibility: 'user_facing' },
        },
        request_id: 'req_mock_invalid_auth',
      }));
      return;
    }

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    res.write('data: {"type":"content_block_delta","delta":{"text":"STREAM_OK"}}\n\n');
    res.write('data: {"type":"message_stop"}\n\n');
    res.end();
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found', method, url }));
});

server.listen(8792, '127.0.0.1', () => {
  console.log('mock Claude upstream listening on http://127.0.0.1:8792');
});
