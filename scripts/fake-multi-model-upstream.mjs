import { createServer } from 'node:http';

const port = Number(process.env.CLE_QA_UPSTREAM_PORT || 25678);
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks).toString('utf8');
  let body = {};
  try { body = JSON.parse(rawBody); } catch { /* multipart or empty */ }
  console.log(JSON.stringify({ method: request.method, url: request.url, model: body.model ?? '', authorization: request.headers.authorization ?? '' }));
  response.setHeader('content-type', 'application/json');
  if (request.url?.includes('/chat/completions')) {
    response.end(JSON.stringify({
      id: 'chatcmpl-ui-qa', object: 'chat.completion', created: 1, model: body.model || 'grok-4.3',
      choices: [{ index: 0, message: { role: 'assistant', content: 'gateway-ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }));
    return;
  }
  if (request.url?.includes('/images/generations')) {
    response.end(JSON.stringify({ created: 1, data: [{ url: 'https://sandbox.invalid/ui-qa.png' }] }));
    return;
  }
  if (request.url?.includes('/videos/generations')) {
    response.end(JSON.stringify({ request_id: 'video-ui-qa', status: 'queued' }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: { message: `unexpected QA upstream route: ${request.url}` } }));
});

server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ type: 'ready', port }));
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
